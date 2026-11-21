/**
 * The peer audit (br-SUMP-000005-sJpO9KMY, br-SUMP-000006-sJpO9KMY,
 * REQ-000017-sJpO9KMY).
 *
 * After a connect, and on demand, every live Sump in the catalog is probed on
 * its own, 4 at a time, each within 10 s; what was found is written back to
 * the catalog. The audit only informs: it adds no Sump, changes no lifecycle
 * state and moves no window.
 *
 * The truth table, for D4 (FEAT-000018-sJpO9KMY):
 * - `/health` answers (any status; through its forward for a remote Sump):
 *   `existing`.
 * - The Sump's port refuses (here, or through SSH to a host that answers):
 *   `absent` if the Sump was `existing` or `absent` before, else `unknown`.
 * - Anything else (a time-out, a host not answering SSH, a port open but
 *   silent): `unknown`.
 *
 * No shell and no OS tool: probes use Node and `ssh2`, and hosts and ports
 * reach them as plain values. cttc pasted a peer's host into PowerShell
 * (cttc BUG-000001-uKKrzikI) and read open ports as closed through telnet
 * (cttc BUG-000002-uKKrzikI).
 */
import { userInfo } from "node:os";
import { privateKeyFrom } from "../identity/sshkey.js";
import type { SshConnect } from "../provision/ssh.js";
import { request } from "../sump/client.js";
import { SumpHttpError } from "../sump/errors.js";
import type { Forwards } from "../sump/forward.js";
import type { Vault } from "../vault/vault.js";
import type { Catalog, Existence, SumpEntry } from "./catalog.js";

/** What one probe saw. */
export interface ProbeResult {
  /** `/health` answered, whatever its status. */
  healthOk: boolean;
  /** The Sump's port refused the connection (and, remotely, the host answered SSH). */
  portRefused: boolean;
}

/** The finding of one audit for one Sump. */
export interface AuditResult {
  id: string;
  existence: Existence;
  lastContactResult: "ok" | "failed";
  lastContactAt: string;
}

/** The truth table. */
export function interpret(probe: ProbeResult, previous: Existence | undefined): Existence {
  if (probe.healthOk) return "existing";
  if (probe.portRefused)
    return previous === "existing" || previous === "absent" ? "absent" : "unknown";
  return "unknown";
}

/** What the audit works with. */
export interface AuditContext {
  catalog: Catalog;
  vault?: Vault;
  forwards?: Forwards;
  connect?: SshConnect;
  logger?: { info(message: string): void };
}

/** Options; tests shorten the limit and check the pool. */
export interface AuditOptions {
  concurrency?: number;
  timeoutMs?: number;
}

const PROBE_SILENT: ProbeResult = { healthOk: false, portRefused: false };

/** `/health` at `baseUrl`: answered, refused, or neither. */
async function healthAt(name: string, baseUrl: string, timeoutMs: number): Promise<ProbeResult> {
  try {
    await request({ name, baseUrl }, "GET", "/health", { timeoutMs, logger: { warn: () => {} } });
    return { healthOk: true, portRefused: false };
  } catch (error) {
    if (error instanceof SumpHttpError) return { healthOk: true, portRefused: false };
    const cause = (error as { cause?: { code?: string } }).cause;
    return { healthOk: false, portRefused: cause?.code === "ECONNREFUSED" };
  }
}

/** Probe one Sump, by the truth table's rules for its kind. */
export async function probe(
  ctx: AuditContext,
  entry: SumpEntry,
  timeoutMs: number,
): Promise<ProbeResult> {
  if (entry.kind === "local")
    return healthAt(entry.id, `http://127.0.0.1:${entry.sumpPort}`, timeoutMs);
  const url = ctx.forwards?.urlOf(entry.id);
  if (url) return healthAt(entry.id, url, timeoutMs);
  // No forward up: ask the host over SSH whether the Sump's port is open.
  if (!ctx.connect || !ctx.vault) return PROBE_SILENT;
  const target = entry.sshTarget ?? "";
  const at = target.lastIndexOf("@");
  let shell: Awaited<ReturnType<SshConnect>> | undefined;
  try {
    const pem = ctx.vault.get(entry.sshKeyId ?? "identity");
    shell = await ctx.connect({
      host: (at === -1 ? target : target.slice(at + 1)).replace(/^\[|\]$/g, ""),
      port: entry.sshPort ?? 22,
      username: at === -1 ? userInfo().username : target.slice(0, at),
      key: privateKeyFrom(pem),
      knownHostKey: entry.hostKey,
      readyTimeoutMs: timeoutMs,
    });
  } catch {
    return PROBE_SILENT; // The host did not answer SSH: nothing can be said.
  }
  try {
    const port = await shell.probePort(entry.sumpPort, timeoutMs);
    return { healthOk: false, portRefused: port === "refused" };
  } finally {
    shell.close();
  }
}

/**
 * Audit every live Sump in the catalog, `concurrency` at a time, each within
 * `timeoutMs` (one that runs over is `unknown`), and write each finding back.
 */
export async function auditSumps(
  ctx: AuditContext,
  options: AuditOptions = {},
): Promise<AuditResult[]> {
  const entries = ctx.catalog.list();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const results: AuditResult[] = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const index = next++;
      const entry = entries[index] as SumpEntry;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const seen = await Promise.race([
        probe(ctx, entry, timeoutMs).catch(() => PROBE_SILENT),
        new Promise<ProbeResult>((resolve) => {
          timer = setTimeout(() => resolve(PROBE_SILENT), timeoutMs + 200);
        }),
      ]);
      clearTimeout(timer);
      const existence = interpret(seen, entry.existence);
      const result: AuditResult = {
        id: entry.id,
        existence,
        lastContactResult: seen.healthOk ? "ok" : "failed",
        lastContactAt: new Date().toISOString(),
      };
      results[index] = result;
      try {
        ctx.catalog.amend(entry.id, {
          existence,
          lastContactAt: result.lastContactAt,
          lastContactResult: result.lastContactResult,
        });
      } catch {
        // Retired while it was probed: its finding is not kept.
      }
      ctx.logger?.info(`audit: Sump ${entry.id} is ${existence}`);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? 4, entries.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/**
 * Runs the audit after each successful connect, and on demand, never two at
 * once: a call while one runs gets that one's results. `soon()` does not wait,
 * so a connect is never held up by it.
 */
export class Auditor {
  private running: Promise<AuditResult[]> | undefined;

  constructor(
    private readonly ctx: AuditContext,
    private readonly options: AuditOptions = {},
  ) {}

  /** Audit now, or join the audit already running. */
  run(): Promise<AuditResult[]> {
    if (!this.running) {
      this.running = auditSumps(this.ctx, this.options).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  /** Audit in the background, after a connect. */
  soon(): void {
    void this.run().catch(() => {});
  }
}
