/**
 * Ship Logs (br-DIAG-000002-sJpO9KMY, cttc's `ship-logs`; REQ-000049-sJpO9KMY):
 * one zip of every local own-log file and the window's Sump's own log.
 *
 * Where to save is asked first. The local files are those in the own log's
 * folder; none, or no folder at all (never configured, or gone: cttc bug 33),
 * is not an error: the Sump's log ships alone. The Sump's entry is always
 * there: its log, or why it is not (not its owner, not reachable, no Sump).
 * Then, only on an explicit yes, the local files are erased, all but the one
 * this run is writing.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { zip } from "../analysis/zipWrite.js";
import type { Sump } from "../sump/client.js";
import { SumpHttpError } from "../sump/errors.js";
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import { LOG_FILE } from "./ownlog.js";

/** The Sump's part of the zip: its file name and what it holds. */
export interface SumpPart {
  name: string;
  text: string;
}

/** What shipping needs. */
export interface ShipDeps {
  /** The own log's folder, or null when it was never set. */
  dir: () => string | null;
  /** The file this run writes, kept when the others are erased. */
  current: () => string | null;
  /** The window's Sump's own log, or why there is none; never throws. */
  sumpLog: () => Promise<SumpPart>;
  /** The save dialog: the path, or null when cancelled. */
  askSave: (suggested: string) => Promise<string | null>;
  /** Ask whether to erase `count` local files now shipped. */
  confirmErase: (count: number) => Promise<boolean>;
  /** Write the zip atomically. */
  write: (file: string, bytes: Buffer) => void | Promise<void>;
  now?: () => Date;
  /** The disk; Node's by default. */
  list?: (dir: string) => string[];
  read?: (file: string) => Buffer;
  remove?: (file: string) => void;
}

/** What shipping answers. */
export type ShipResult =
  | { ok: true; file: string; local: number; erased: number }
  | { ok: false; cancelled?: true; message?: string };

/** The zip's name, as cttc's: `correlate-logs-2026-11-22-19-30-00.zip`. */
export function shipName(now: Date): string {
  return `correlate-logs-${now.toISOString().slice(0, 19).replace(/[T:]/g, "-")}.zip`;
}

/** The own-log files in `dir`, oldest first; none when it is missing. */
export function localLogs(dir: string | null, list: (d: string) => string[]): string[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    return list(dir)
      .filter((f) => LOG_FILE.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** Ship: asked first, zipped, written, then the local files erased on a yes. Never throws. */
export async function shipLogs(deps: ShipDeps): Promise<ShipResult> {
  const now = (deps.now ?? (() => new Date()))();
  const file = await deps.askSave(shipName(now));
  if (!file) return { ok: false, cancelled: true };
  try {
    const locals = localLogs(deps.dir(), deps.list ?? ((d) => readdirSync(d)));
    const read = deps.read ?? ((f: string) => readFileSync(f));
    const entries: Record<string, string | Buffer> = {};
    for (const local of locals) entries[path.basename(local)] = read(local);
    const sump = await deps.sumpLog();
    entries[sump.name] = sump.text;
    await deps.write(file, zip(entries));
    let erased = 0;
    const current = deps.current();
    const others = locals.filter((f) => f !== current);
    if (others.length > 0 && (await deps.confirmErase(others.length))) {
      const remove = deps.remove ?? ((f: string) => rmSync(f, { force: true }));
      for (const f of others) {
        remove(f);
        erased++;
      }
    }
    return { ok: true, file, local: locals.length, erased };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/** A Sump's log file name from its name: letters, digits, `.`, `_` and `-`. */
export function sumpLogName(sump: string): string {
  return `${sump.replace(/[^A-Za-z0-9._-]+/g, "-") || "sump"}.log`;
}

/** Fetch a Sump's log (`download` is the client's); never throws. */
export async function fetchSumpLog(
  sump: Sump | undefined,
  download: (sump: Sump, path: string, onChunk: (c: Uint8Array) => void) => Promise<void>,
): Promise<SumpPart> {
  if (!sump) {
    return {
      name: "sump.log",
      text: "No Sump is active in this window: only the local logs are shipped.\n",
    };
  }
  const name = sumpLogName(sump.name);
  try {
    const chunks: Buffer[] = [];
    await download(sump, "/logs/sump", (c) => {
      chunks.push(Buffer.from(c));
    });
    return { name, text: Buffer.concat(chunks).toString("utf8") };
  } catch (error) {
    if (error instanceof SumpHttpError && error.status === 403)
      return { name, text: "Not shipped: only the Sump's owner can ship its log.\n" };
    return { name, text: `Could not reach the Sump: ${(error as Error).message}\n` };
  }
}

export const LOGS_SHIP_CHANNEL = "logs:ship";

/** Answer `logs:ship` with the calling window's deps. */
export function registerShipIpc(
  ipcMain: IpcMainLike,
  depsFor: (event: IpcEventLike) => ShipDeps,
): void {
  ipcMain.handle(LOGS_SHIP_CHANNEL, (event) => shipLogs(depsFor(event)));
}
