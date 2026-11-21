/**
 * Temporary key files for external tools (br-VAULT-000001-sJpO9KMY,
 * REQ-000008-sJpO9KMY Requirement 4): written owner-only on every system
 * (br-VAULT-000006-sJpO9KMY) and always deleted.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { restrictToOwner, writeSecretFile } from "./secure.js";

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
    restrictToOwner(dir, "dir");
    const file = path.join(dir, "key");
    writeSecretFile(file, key);
    return await use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    liveKeyDirs.delete(dir);
  }
}
