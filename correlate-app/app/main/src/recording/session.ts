/**
 * The recording session (REQ-000037-sJpO9KMY Requirement 2,
 * br-REC-000002-sJpO9KMY), cttc's (`app.js` ~3300-3580), one for the app:
 *
 * - idle → Start (no prompt; the scratch file emptied) → recording.
 * - recording → Pause (the segment flushed; a failed flush stays recording)
 *   → paused → Start (a new segment from now) → recording.
 * - recording → every 10 minutes, the segment so far flushed as a piece of
 *   the same segment, so the Sump's cap never loses its start.
 * - recording or paused → Stop (a recording segment flushed first; a failure
 *   stays recording) → stopped → the save dialog: cancelled or failed, it
 *   stays stopped and Stop asks again; saved, idle, and the recording joins
 *   the open project.
 *
 * The scratch file is a valid `*.recording` after every flush. What is
 * recorded is fixed at Start: the Sump, the stream, its followed containers
 * and host, so a later switch of the window never mixes another stream in.
 *
 * Crash recovery (REQ-000038-sJpO9KMY, cttc's `recoverInterruptedRecording`):
 * a marker follows the session through every change and flush; at the next
 * start, a recording that was running comes back paused, the part of its
 * segment already flushed kept, the interruption offered to resume from (or
 * from now, or later); a paused one comes back paused, a stopped one
 * stopped. When the recording's Sump has left the catalog, Resume is
 * refused, and Stop saves what was flushed.
 */
import type { SegmentData } from "./archive.js";
import { appendToRecording } from "./archive.js";

/** The flush period while recording: 10 minutes. */
export const PIECE_EVERY_MS = 10 * 60 * 1000;

export type RecordingStatus = "idle" | "recording" | "paused" | "stopped";

/** What Start records. */
export interface RecordingTarget {
  /** The Sump's catalog id. */
  sump: string;
  stream: string;
  /** The stream's followed containers. */
  containers: string[];
  /** Its host's telemetry too. */
  host: boolean;
}

/** What the windows are told. */
export interface RecordingState {
  status: RecordingStatus;
  target: RecordingTarget | null;
  /** The completed segments' ranges (ms), for the chart's captured band. */
  segments: { from: number; to: number }[];
  /** The current segment's start, while recording. */
  segmentStart: number | null;
  /** A recording interrupted by a crash, offered to resume (REQ-000038-sJpO9KMY). */
  interrupted: { segmentStart: number; pieceStart: number; restartAt: number } | null;
  /** The recording's Sump has left the catalog: Resume is refused. */
  sumpGone: boolean;
}

/** What the marker on disk holds. */
export interface RecordingMarker {
  status: Exclude<RecordingStatus, "idle">;
  target: RecordingTarget;
  segments: { from: number; to: number }[];
  segmentStart: number | null;
  pieceStart: number | null;
  startedAt: number;
}

/** A marker read back, or null when it is not one (its fields checked). */
export function parseMarker(value: unknown): RecordingMarker | null {
  const m = (value ?? {}) as Record<string, unknown>;
  const t = (m.target ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const statuses = ["recording", "paused", "stopped"];
  if (
    typeof m.status !== "string" ||
    !statuses.includes(m.status) ||
    typeof t.sump !== "string" ||
    typeof t.stream !== "string" ||
    !Array.isArray(t.containers) ||
    !t.containers.every((c) => typeof c === "string") ||
    !num(m.startedAt) ||
    !Array.isArray(m.segments) ||
    !m.segments.every((g) => num((g as { from?: unknown }).from) && num((g as { to?: unknown }).to))
  ) {
    return null;
  }
  return {
    status: m.status as RecordingMarker["status"],
    target: {
      sump: t.sump,
      stream: t.stream,
      containers: t.containers as string[],
      host: t.host === true,
    },
    segments: m.segments as { from: number; to: number }[],
    segmentStart: num(m.segmentStart) ? (m.segmentStart as number) : null,
    pieceStart: num(m.pieceStart) ? (m.pieceStart as number) : null,
    startedAt: m.startedAt as number,
  };
}

/** What the session needs from the app. */
export interface RecordingDeps {
  scratch: string;
  /** One call to a Sump, by its id. */
  fetchSegment: (
    sump: string,
    query: Record<string, string>,
  ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>;
  read: (file: string) => Promise<Buffer | null>;
  write: (file: string, bytes: Buffer) => Promise<void>;
  /** The save dialog: a path, or null when cancelled. */
  askSave: (suggested: string) => Promise<string | null>;
  /** Copy the finished recording to where the user chose. */
  copy: (from: string, to: string) => Promise<void>;
  /** The saved recording joins the open project. */
  addToProject: (file: string) => void;
  notify: (text: string) => void;
  changed: (state: RecordingState) => void;
  /** Keep the marker on disk; null removes it (REQ-000038-sJpO9KMY). */
  saveMarker?: (marker: RecordingMarker | null) => Promise<void>;
  now?: () => number;
}

/** A name for a saved recording: its stream and when it started. */
export function suggestedName(stream: string, startedAt: number): string {
  const safe = stream.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "recording";
  return `${safe}-${new Date(startedAt).toISOString().slice(0, 19).replace(/[T:]/g, "-")}.recording`;
}

/** The app's recording session. */
export class RecordingSession {
  private status: RecordingStatus = "idle";
  private target: RecordingTarget | null = null;
  private segments: { from: number; to: number }[] = [];
  private segmentStart: number | null = null;
  /** Where the next piece of the current segment starts. */
  private pieceStart: number | null = null;
  private startedAt = 0;
  private flushing: Promise<unknown> = Promise.resolve();
  private interrupted: RecordingState["interrupted"] = null;
  private sumpGone = false;

  constructor(private readonly deps: RecordingDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  state(): RecordingState {
    return {
      status: this.status,
      target: this.target,
      segments: [...this.segments],
      segmentStart: this.segmentStart,
      interrupted: this.interrupted,
      sumpGone: this.sumpGone,
    };
  }

  /**
   * What abandoning would lose, for the confirmations (REQ-000039-sJpO9KMY):
   * "in progress", "paused", "stopped but not saved", or undefined when idle.
   */
  live(): string | undefined {
    if (this.status === "recording") return "in progress";
    if (this.status === "paused") return "paused";
    if (this.status === "stopped") return "stopped but not saved";
    return undefined;
  }

  /**
   * Abandon the recording (cttc's `discardRecording`, br-REC-000001-sJpO9KMY):
   * the scratch file emptied, the marker removed, idle. A no-op when idle.
   */
  async discard(): Promise<RecordingState> {
    return this.serial(async () => {
      if (this.status === "idle") return this.state();
      try {
        await this.deps.write(this.deps.scratch, Buffer.alloc(0));
      } catch {
        // Best effort: the next Start empties it again.
      }
      this.status = "idle";
      this.target = null;
      this.segments = [];
      this.segmentStart = this.pieceStart = null;
      this.interrupted = null;
      this.sumpGone = false;
      this.tell("Recording discarded");
      return this.state();
    });
  }

  /** The marker for the current state, or null when idle. */
  marker(): RecordingMarker | null {
    if (this.status === "idle" || !this.target) return null;
    return {
      status: this.status,
      target: this.target,
      segments: [...this.segments],
      segmentStart: this.segmentStart,
      pieceStart: this.pieceStart,
      startedAt: this.startedAt,
    };
  }

  /** Keep the marker; a failure is said, the recording goes on. */
  private async persist(): Promise<void> {
    try {
      await this.deps.saveMarker?.(this.marker());
    } catch (error) {
      this.deps.notify(`Could not keep the recording's marker: ${(error as Error).message}`);
    }
  }

  private tell(text?: string): void {
    if (text) this.deps.notify(text);
    this.deps.changed(this.state());
    void this.persist();
  }

  /**
   * Recover from a marker left by a crash (cttc's `recoverInterruptedRecording`):
   * recording → paused, the interrupted segment's flushed part kept and the
   * interruption offered; paused → paused; stopped → stopped. `sumpKnown`:
   * the recording's Sump is still in the catalog.
   */
  recover(marker: RecordingMarker, sumpKnown: boolean): RecordingState {
    const restartAt = this.now();
    this.target = marker.target;
    this.startedAt = marker.startedAt;
    this.segments = [...marker.segments];
    this.segmentStart = this.pieceStart = null;
    this.sumpGone = !sumpKnown;
    this.interrupted = null;
    if (marker.status === "stopped") {
      this.status = "stopped";
      this.tell(
        "A previous recording finished but wasn't saved yet: Stop to choose where to save it",
      );
      return this.state();
    }
    this.status = "paused";
    if (marker.status === "recording" && marker.segmentStart !== null) {
      const flushedTo = marker.pieceStart ?? marker.segmentStart;
      if (flushedTo > marker.segmentStart)
        this.segments.push({ from: marker.segmentStart, to: flushedTo });
      this.interrupted = { segmentStart: marker.segmentStart, pieceStart: flushedTo, restartAt };
      this.tell(
        this.sumpGone
          ? `A previous recording was interrupted; its Sump ${marker.target.sump} is no longer known: Stop saves what was recorded`
          : "A previous recording was interrupted and is now paused: Resume to continue, or Stop to finish",
      );
    } else {
      this.tell("A previous recording is paused: Resume to continue, or Stop to finish");
    }
    return this.state();
  }

  /** The recovery dialog's choice: resume from the interruption point, or from the restart. */
  async resume(from: "interruption" | "now"): Promise<RecordingState> {
    const gap = this.interrupted;
    if (this.status !== "paused" || !gap) return this.state();
    if (this.sumpGone) {
      this.deps.notify("The recording's Sump is no longer known: it cannot be resumed");
      return this.state();
    }
    this.interrupted = null;
    if (from === "interruption") {
      // The same segment continues: its flushed part is no longer a separate range.
      const last = this.segments[this.segments.length - 1];
      if (last && last.from === gap.segmentStart) this.segments.pop();
      this.segmentStart = gap.segmentStart;
      this.pieceStart = gap.pieceStart;
      this.status = "recording";
      this.tell(
        `Resumed from the interruption point (continuing since ${new Date(gap.segmentStart).toLocaleString()})`,
      );
    } else {
      this.segmentStart = this.pieceStart = gap.restartAt;
      this.status = "recording";
      this.tell("Resumed from now: the interruption is left as a gap");
    }
    return this.state();
  }

  /** Start, or resume a paused recording; nothing in another state. */
  async start(target?: RecordingTarget): Promise<RecordingState> {
    if (this.status === "idle") {
      if (!target || target.containers.length === 0) {
        this.deps.notify("Nothing to record: follow containers on the active data stream first");
        return this.state();
      }
      await this.deps.write(this.deps.scratch, Buffer.alloc(0));
      this.target = target;
      this.segments = [];
      this.startedAt = this.now();
      this.segmentStart = this.pieceStart = this.startedAt;
      this.status = "recording";
      this.tell(`Recording started on ${target.stream}`);
    } else if (this.status === "paused") {
      if (this.sumpGone) {
        this.deps.notify("The recording's Sump is no longer known: it cannot be resumed");
        return this.state();
      }
      this.interrupted = null;
      this.segmentStart = this.pieceStart = this.now();
      this.status = "recording";
      this.tell("Recording resumed");
    }
    return this.state();
  }

  /** Flush the current segment up to `to`: a new segment, or a piece of it. */
  private async flush(to: number): Promise<void> {
    const target = this.target;
    const from = this.pieceStart;
    if (!target || from === null || this.segmentStart === null)
      throw new Error("nothing is being recorded");
    const piece = from === this.segmentStart ? "new" : "extend";
    const reply = await this.deps.fetchSegment(target.sump, {
      sources: target.containers.map((c) => `${target.stream}/${c}`).join(","),
      ...(target.host ? { host: `${target.stream}/__host__` } : {}),
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
    });
    if (!reply.ok) throw new Error(reply.error.message);
    const existing = await this.deps.read(this.deps.scratch);
    const data = reply.value as SegmentData;
    // A piece's segment keeps its first start.
    const bytes = appendToRecording(
      existing,
      { ...data, from: piece === "new" ? data.from : this.segmentStart },
      piece,
    );
    await this.deps.write(this.deps.scratch, bytes);
    this.pieceStart = to;
    await this.persist();
  }

  /** One flush at a time: a pause during a timed flush waits for it. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.flushing.then(run, run);
    this.flushing = next.catch(() => {});
    return next;
  }

  /** Run `tick` every 10 minutes from now on; returns the function that stops it. */
  startTicking(every = PIECE_EVERY_MS): () => void {
    const timer = setInterval(() => void this.tick(), every);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** The 10-minute flush while recording; a failure is said and retried at the next. */
  async tick(): Promise<void> {
    if (this.status !== "recording") return;
    await this.serial(async () => {
      if (this.status !== "recording") return;
      try {
        await this.flush(this.now());
      } catch (error) {
        this.deps.notify(`Could not save the recording so far: ${(error as Error).message}`);
      }
    });
  }

  /** Pause: the segment flushed and kept; a failed flush stays recording. */
  async pause(): Promise<RecordingState> {
    return this.serial(async () => {
      if (this.status !== "recording" || this.segmentStart === null) return this.state();
      const to = this.now();
      try {
        await this.flush(to);
      } catch (error) {
        this.tell(`Could not pause recording: ${(error as Error).message}`);
        return this.state();
      }
      this.segments = [...this.segments, { from: this.segmentStart, to }];
      this.segmentStart = this.pieceStart = null;
      this.status = "paused";
      this.tell("Recording paused");
      return this.state();
    });
  }

  /**
   * Stop: a recording segment flushed first (a failure stays recording),
   * then the save dialog; cancelled or failed, it stays stopped.
   */
  async stop(): Promise<RecordingState> {
    return this.serial(async () => {
      if (this.status === "idle") return this.state();
      if (this.status === "recording") {
        try {
          await this.flush(this.now());
        } catch (error) {
          this.tell(`Could not finish the recording: ${(error as Error).message}`);
          return this.state();
        }
      }
      this.interrupted = null;
      if (this.status !== "stopped") {
        this.status = "stopped";
        this.segments = [];
        this.segmentStart = this.pieceStart = null;
        this.tell();
      }
      const path = await this.deps.askSave(
        suggestedName(this.target?.stream ?? "recording", this.startedAt),
      );
      if (!path) {
        this.tell("Recording stopped but not saved: Stop again to choose a file");
        return this.state();
      }
      try {
        await this.deps.copy(this.deps.scratch, path);
      } catch (error) {
        this.tell(`Could not save the recording: ${(error as Error).message}`);
        return this.state();
      }
      this.deps.addToProject(path);
      this.status = "idle";
      this.target = null;
      this.interrupted = null;
      this.sumpGone = false;
      this.tell(`Recording saved to ${path}`);
      return this.state();
    });
  }
}
