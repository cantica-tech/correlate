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
    };
  }

  private tell(text?: string): void {
    if (text) this.deps.notify(text);
    this.deps.changed(this.state());
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
      this.tell(`Recording saved to ${path}`);
      return this.state();
    });
  }
}
