/**
 * How the vault touches the disk (br-VAULT-000001-sJpO9KMY,
 * REQ-000008-sJpO9KMY Requirements 2 and 4): files written atomically and
 * owner-only, and temporary key files that are always deleted.
 *
 * Owner-only here means POSIX modes (0600 files, 0700 folders). Windows
 * permissions, and checking every secret file, come with Item 10
 * (br-VAULT-000006-sJpO9KMY).
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const POSIX = process.platform !== "win32";

/** Create `dir` (and its parents) readable by its owner only. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX) chmodSync(dir, 0o700);
}

/**
 * Write `data` to `file` atomically: to a temporary name beside it, flushed,
 * then renamed into place. A crash leaves the old file or the new one, never
 * half of either, and the temporary name is removed on failure.
 */
export function writeAtomic(file: string, data: string | Buffer): void {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (POSIX) chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Folders holding decrypted key files right now; emptied at exit if still there. */
const liveKeyDirs = new Set<string>();
let exitHookInstalled = false;

/** Delete every key file still on disk; runs at process exit. */
function deleteLiveKeyDirs(): void {
  for (const dir of liveKeyDirs) rmSync(dir, { recursive: true, force: true });
  liveKeyDirs.clear();
}

/**
 * Write `key` to an owner-only file in a fresh owner-only folder, run `use`
 * with its path, and delete both however `use` ends. For external tools
 * only: everything in the app takes keys from memory (FEAT-000009-sJpO9KMY).
 */
export async function withTemporaryKeyFile<T>(
  key: string,
  use: (file: string) => T | Promise<T>,
): Promise<T> {
  if (!exitHookInstalled) {
    process.once("exit", deleteLiveKeyDirs);
    exitHookInstalled = true;
  }
  const dir = mkdtempSync(path.join(tmpdir(), "correlate-key-"));
  liveKeyDirs.add(dir);
  try {
    if (POSIX) chmodSync(dir, 0o700);
    const file = path.join(dir, "key");
    const fd = openSync(file, "wx", 0o600);
    try {
      writeSync(fd, Buffer.from(key, "utf8"));
    } finally {
      closeSync(fd);
    }
    return await use(file);
  } finally {
    try {
      unlinkSync(path.join(dir, "key"));
    } catch {
      // Already gone, or never written.
    }
    rmSync(dir, { recursive: true, force: true });
    liveKeyDirs.delete(dir);
  }
}
