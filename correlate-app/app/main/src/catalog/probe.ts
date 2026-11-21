/**
 * The health probe (br-SUMP-000011-sJpO9KMY, REQ-000013-sJpO9KMY
 * Requirement 3): every 30 seconds, each Sump that is `active` or
 * `unreachable` is asked for `/health`, within 5 seconds; an answer makes it
 * `active`, silence `unreachable`. Probes of one Sump never overlap.
 */
import { request } from "../sump/client.js";
import { SumpHttpError } from "../sump/errors.js";
import type { SumpResolver } from "../sump/ipc.js";
import type { Lifecycle } from "./lifecycle.js";

/** How often each live Sump is probed. */
export const PROBE_INTERVAL_MS = 30_000;

/** How long a probe waits for `/health`. */
export const PROBE_TIMEOUT_MS = 5_000;

export class HealthProbe {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Set<string>();

  constructor(
    private readonly lifecycle: Lifecycle,
    private readonly resolve: SumpResolver,
    private readonly options: { intervalMs?: number; timeoutMs?: number } = {},
  ) {}

  /** Probe every live Sump once; resolves when all have answered or timed out. */
  async probeOnce(): Promise<void> {
    const live = this.lifecycle
      .states()
      .filter((r) => r.state === "active" || r.state === "unreachable");
    await Promise.all(live.map((r) => this.probe(r.id)));
  }

  /** Probe now, then every interval, until `stop`. */
  start(): void {
    if (this.timer) return;
    void this.probeOnce();
    this.timer = setInterval(
      () => void this.probeOnce(),
      this.options.intervalMs ?? PROBE_INTERVAL_MS,
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
