/**
 * Following events' firings (REQ-000046-sJpO9KMY Requirement 2, decision D7):
 * the app never evaluates an event; each Sump it is logged in to streams its
 * user's firings (`GET /events/firings/stream`), and each one is said in the
 * status bar and its history, and told to the windows.
 *
 * One stream per logged-in Sump, re-synced every few seconds (a login opens
 * one, a logout closes it). A dropped stream reconnects with a growing delay,
 * resuming after the last firing received (`after`), so none is missed or
 * said twice.
 */
import type { Sump, SumpEvent, SumpStream } from "../sump/client.js";

/** A firing as the Sump streams it. */
export interface Firing {
  event: string;
  name: string;
  owner?: string;
  stream?: string;
  at: string;
  detail: string;
  count?: string;
  artifact?: string;
  note?: string;
}

/** A firing told to the windows: which Sump, and its stream id. */
export interface ToldFiring extends Firing {
  sump: string;
  id: string;
}

/** What following needs. */
export interface FollowerDeps {
  /** The Sumps the app is logged in to (their catalog ids). */
  sumps: () => string[];
  /** A Sump, with its token, to call. */
  resolve: (id: string) => Sump | undefined;
  /** A Sump's name, for the status bar. */
  name: (id: string) => string;
  /** Open a stream (the client's `stream`). */
  open: (
    sump: Sump,
    path: string,
    onEvent: (event: SumpEvent) => void,
    options: { query?: Record<string, string> },
  ) => SumpStream;
  /** Say a firing in the status bar and its history. */
  notify: (text: string) => void;
  /** Tell the windows. */
  told: (firing: ToldFiring) => void;
  /** Wait before reconnecting, growing: the first and the longest (ms). */
  retryMs?: number;
  maxRetryMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface Followed {
  stream: SumpStream | null;
  /** The last firing's stream id: a reconnect resumes after it. */
  last: string | null;
  retry: unknown;
  delay: number;
}

/** The firing in the status bar's words (cttc's "Event … fired"). */
export function firingText(firing: Firing, sump: string | null): string {
  const where = sump ? ` on ${sump}` : "";
  const detail = firing.detail ? `: ${firing.detail}` : "";
  const note = firing.note ? ` (${firing.note})` : "";
  return `Event "${firing.name}" fired${where}${detail}${note}`;
}

/** The followed Sumps' firings. */
export class FiringsFollower {
  private readonly followed = new Map<string, Followed>();
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: FollowerDeps) {}

  /** Follow every logged-in Sump, and only those. */
  sync(): void {
    const wanted = new Set(this.deps.sumps());
    for (const id of wanted) if (!this.followed.has(id)) this.follow(id, null);
    for (const id of [...this.followed.keys()]) if (!wanted.has(id)) this.stop(id);
  }

  /** Re-sync every `every` ms until `stop`. */
  start(every = 5_000): () => void {
    this.sync();
    this.ticker = setInterval(() => this.sync(), every);
    this.ticker.unref?.();
    return () => this.stopAll();
  }

  /** Stop following everything. */
  stopAll(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const id of [...this.followed.keys()]) this.stop(id);
  }

  /** The Sumps followed now. */
  following(): string[] {
    return [...this.followed.keys()];
  }

  private stop(id: string): void {
    const f = this.followed.get(id);
    if (!f) return;
    this.followed.delete(id);
    f.stream?.close();
    if (f.retry !== null) (this.deps.clearTimer ?? clearTimeout)(f.retry as never);
  }

  private follow(id: string, before: Followed | null): void {
    const sump = this.deps.resolve(id);
    const f: Followed = before ?? {
      stream: null,
      last: null,
      retry: null,
      delay: this.deps.retryMs ?? 2_000,
    };
    f.retry = null;
    this.followed.set(id, f);
    if (!sump) {
      this.again(id, f);
      return;
    }
    const stream = this.deps.open(sump, "/events/firings/stream", (e) => this.heard(id, f, e), {
      query: f.last ? { after: f.last } : undefined,
    });
    f.stream = stream;
    stream.done.then(
      () => this.again(id, f),
      () => this.again(id, f),
    );
  }

  /** The stream ended or failed: reconnect later, if still followed. */
  private again(id: string, f: Followed): void {
    if (this.followed.get(id) !== f || f.retry !== null) return;
    f.stream = null;
    const wait = f.delay;
    f.delay = Math.min(f.delay * 2, this.deps.maxRetryMs ?? 60_000);
    f.retry = (this.deps.setTimer ?? setTimeout)(() => {
      if (this.followed.get(id) === f) this.follow(id, f);
    }, wait);
  }

  private heard(id: string, f: Followed, event: SumpEvent): void {
    if (event.event !== "firing") return;
    let firing: Firing;
    try {
      firing = JSON.parse(event.data) as Firing;
    } catch {
      return;
    }
    if (event.id) f.last = event.id;
    // A healthy stream: the next drop starts the wait afresh.
    f.delay = this.deps.retryMs ?? 2_000;
    const several = this.followed.size > 1;
    this.deps.notify(firingText(firing, several ? this.deps.name(id) : null));
    this.deps.told({ ...firing, sump: id, id: event.id ?? "" });
  }
}
