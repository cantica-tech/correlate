/**
 * Files the OS hands the app (REQ-000036-sJpO9KMY Requirement 1, decided in
 * FEAT-000037-sJpO9KMY): from the launch's command line, macOS's `open-file`,
 * and a second launch's command line (the app runs once). Projects and
 * captures are taken; anything else is ignored and said. Files that arrive
 * before the window is ready wait for it, in order.
 *
 * - `open:take`: the window is ready; the files waiting so far.
 * - `open:files` (to the window): files arriving later.
 */
import path from "node:path";
import type { IpcMainLike } from "./sump/ipc.js";

export const OPEN_TAKE_CHANNEL = "open:take";
export const OPEN_FILES_EVENT = "open:files";

/** A project's extension. */
export const PROJECT_EXTENSIONS = [".correlator"];
/** A capture's: the app's own (Phase 8 writes them) and cttc's, read alike. */
export const CAPTURE_EXTENSIONS = [".recording", ".track", ".cttc-record", ".cttc-metric"];

/** What the window is given: the files taken, and those ignored. */
export interface Arrived {
  files: string[];
  ignored: string[];
}

/** A file's kind by its extension, or null when the app does not open it. */
export function kindOf(file: string): "project" | "capture" | null {
  const ext = path.extname(file).toLowerCase();
  if (PROJECT_EXTENSIONS.includes(ext)) return "project";
  if (CAPTURE_EXTENSIONS.includes(ext)) return "capture";
  return null;
}

/**
 * The files on a command line: the executable left out, and the app's own
 * folder when Electron runs it unpackaged (`electron .`); switches left out;
 * paths resolved from `cwd`; split into those taken and those ignored.
 */
export function filesFromArgv(argv: readonly string[], cwd: string, unpackaged: boolean): Arrived {
  const args = argv.slice(unpackaged ? 2 : 1).filter((a) => a && !a.startsWith("-"));
  const arrived: Arrived = { files: [], ignored: [] };
  for (const arg of args) {
    const file = path.resolve(cwd, arg);
    if (kindOf(file)) arrived.files.push(file);
    else arrived.ignored.push(file);
  }
  return arrived;
}

/** Files waiting for the window, then handed to it as they come. */
export class Inbox {
  private waiting: Arrived = { files: [], ignored: [] };
  private ready = false;

  constructor(private readonly send: (arrived: Arrived) => void) {}

  /** Files arrived; sent at once when the window is ready, else kept. */
  push(arrived: Arrived): void {
    if (arrived.files.length === 0 && arrived.ignored.length === 0) return;
    if (this.ready) {
      this.send(arrived);
      return;
    }
    this.waiting = {
      files: [...this.waiting.files, ...arrived.files],
      ignored: [...this.waiting.ignored, ...arrived.ignored],
    };
  }

  /** The window is ready: what waited so far; later files are sent. */
  take(): Arrived {
    this.ready = true;
    const waited = this.waiting;
    this.waiting = { files: [], ignored: [] };
    return waited;
  }

  /** The window went (it will take again when a new one is ready). */
  reset(): void {
    this.ready = false;
  }
}

/** Answer `open:take`. */
export function registerOpenIpc(ipcMain: IpcMainLike, inbox: Inbox): void {
  ipcMain.handle(OPEN_TAKE_CHANNEL, () => inbox.take());
}
