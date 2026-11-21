/**
 * The health probe (br-SUMP-000011-sJpO9KMY, REQ-000013-sJpO9KMY
 * Requirement 3, REQ-000022-sJpO9KMY Requirement 1): each Sump that is
 * `active` or `unreachable` is asked for `/health`, within 5 seconds, every
 * 5 seconds while a window is on it and every 30 seconds otherwise; an
 * answer makes it `active`, silence `unreachable`. Probes of one Sump never
 * overlap.
 */
import { request } from "../sump/client.js";
import { SumpHttpError } from "../sump/errors.js";
import type { SumpResolver } from "../sump/ipc.js";
import type { Lifecycle } from "./lifecycle.js";

/** How often a live Sump no window is on is probed. */
export const PROBE_INTERVAL_MS = 30_000;

/** How often a Sump a window is on is probed (decided in FEAT-000023-sJpO9KMY). */
export const IN_USE_INTERVAL_MS = 5_000;

/** How long a probe waits for `/health`. */
export const PROBE_TIMEOUT_MS = 5_000;

export class HealthProbe {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Set<string>();
  private readonly lastProbed = new Map<string, number>();

  constructor(
    private readonly lifecycle: Lifecycle,
    private readonly resolve: SumpResolver,
    private readonly options: {
      intervalMs?: number;
      inUseIntervalMs?: number;
      timeoutMs?: number;
      /** The Sumps some window is on (ActiveSumps.inUse). */
      inUse?: () => ReadonlySet<string>;
      now?: () => number;
    } = {},
  ) {}

  /**
   * One tick: probe each live Sump in use, and each other one whose last
   * probe is at least the long interval old.
   */
  async tick(): Promise<void> {
    const now = (this.options.now ?? Date.now)();
    const inUse = this.options.inUse?.() ?? new Set<string>();
    const every = this.options.intervalMs ?? PROBE_INTERVAL_MS;
    const due = this.live().filter(
      (id) => inUse.has(id) || now - (this.lastProbed.get(id) ?? Number.NEGATIVE_INFINITY) >= every,
    );
    await Promise.all(due.map((id) => this.probe(id)));
  }

  private live(): string[] {
    return this.lifecycle
      .states()
      .filter((r) => r.state === "active" || r.state === "unreachable")
      .map((r) => r.id);
  }

  /** Probe every live Sump once; resolves when all have answered or timed out. */
  async probeOnce(): Promise<void> {
    await Promise.all(this.live().map((id) => this.probe(id)));
  }

  /** Probe every live Sump now, then tick every short interval, until `stop`. */
  start(): void {
    if (this.timer) return;
    void this.probeOnce();
    this.timer = setInterval(
      () => void this.tick(),
      this.options.inUseIntervalMs ?? IN_USE_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async probe(id: string): Promise<void> {
    if (this.running.has(id)) return;
    const sump = this.resolve(id);
    if (!sump) return; // Not reachable yet: a remote Sump waits for its SSH forward (Item 17).
    this.running.add(id);
    this.lastProbed.set(id, (this.options.now ?? Date.now)());
    try {
      await request(sump, "GET", "/health", {
        timeoutMs: this.options.timeoutMs ?? PROBE_TIMEOUT_MS,
        logger: { warn: () => {} },
      });
      this.lifecycle.reachable(id, "answered /health");
    } catch (error) {
      if (error instanceof SumpHttpError) {
        // Any answer, even an error status, means the Sump is there.
        this.lifecycle.reachable(id, `answered /health with ${error.status}`);
      } else {
        this.lifecycle.unreachable(id, `no /health: ${(error as Error).message}`);
      }
    } finally {
      this.running.delete(id);
    }
  }
}
