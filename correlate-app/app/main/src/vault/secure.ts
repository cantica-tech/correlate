/**
 * Secret files are owner-only (br-VAULT-000006-sJpO9KMY, REQ-000009-sJpO9KMY
 * Requirement 2). Every file that holds a secret (vault files, temporary key
 * files, session tokens from Item 11) is written with `writeSecretFile`, in a
 * folder made with `ensurePrivateDir`.
 *
 * - macOS and Linux: files 0600, folders 0700.
 * - Windows: `icacls` removes inherited access and grants full control to
 *   the current user alone, named by SID (read once from `whoami /user`),
 *   as decided in FEAT-000010-sJpO9KMY.
 *
 * `ownerOnlyProblems` reads permissions back and says what is wrong. A
 * failure to restrict is an error, never ignored: cttc wrote its token file
 * with default permissions (cttc BUG-000010-uKKrzikI).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";

/** What a command printed and how it ended. */
export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command; injectable so tests can check the Windows calls anywhere. */
export type CommandRunner = (command: string, args: string[]) => CommandResult;

/** The system the helpers act for. */
interface Platform {
  windows: boolean;
  run: CommandRunner;
}

const runCommand: CommandRunner = (command, args) => {
  const r = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 15_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr || r.error?.message || "" };
};

let platform: Platform = { windows: process.platform === "win32", run: runCommand };
let windowsUser: WindowsUser | undefined;

/** Act as another system in tests; returns a function that restores the real one. */
export function overridePlatformForTests(override: Partial<Platform>): () => void {
  const saved = platform;
  platform = { ...platform, ...override };
  windowsUser = undefined;
  return () => {
    platform = saved;
    windowsUser = undefined;
  };
}

/** A file or folder could not be made, or shown to be, owner-only. */
export class SecretFileError extends Error {
  override readonly name = "SecretFileError";
}

/** The current Windows user: `DOMAIN\name` and SID. */
export interface WindowsUser {
  name: string;
  sid: string;
}

/** The current Windows user, from `whoami /user /fo csv /nh`, read once. */
export function currentWindowsUser(): WindowsUser {
  if (windowsUser) return windowsUser;
  const r = platform.run("whoami", ["/user", "/fo", "csv", "/nh"]);
  const match = /^"(.+)","(S-1-[\d-]+)"\s*$/m.exec(r.stdout);
  if (r.status !== 0 || !match) {
    throw new SecretFileError(`cannot tell the current user's SID: ${r.stdout}${r.stderr}`.trim());
  }
  windowsUser = { name: match[1] as string, sid: match[2] as string };
  return windowsUser;
}

/** Make `target` readable and writable by its owner only. */
export function restrictToOwner(target: string, kind: "file" | "dir"): void {
  if (!platform.windows) {
    chmodSync(target, kind === "dir" ? 0o700 : 0o600);
    return;
  }
  const { sid } = currentWindowsUser();
  const grant = `*${sid}:${kind === "dir" ? "(OI)(CI)(F)" : "(F)"}`;
  const r = platform.run("icacls", [target, "/inheritance:r", "/grant:r", grant]);
  if (r.status !== 0) {
    throw new SecretFileError(`cannot restrict ${target}: ${r.stdout}${r.stderr}`.trim());
  }
}

/** What makes `target` readable by someone other than its owner; empty when owner-only. */
export function ownerOnlyProblems(target: string): string[] {
  if (!platform.windows) {
    const stat = statSync(target);
    const problems: string[] = [];
    if ((stat.mode & 0o077) !== 0) {
      problems.push(`group or others have access (mode ${(stat.mode & 0o777).toString(8)})`);
    }
    if (process.getuid && stat.uid !== process.getuid()) {
      problems.push(`owned by uid ${stat.uid}, not the current user`);
    }
    return problems;
  }
  const user = currentWindowsUser();
  const r = platform.run("icacls", [target]);
  if (r.status !== 0) return [`cannot read permissions: ${r.stdout}${r.stderr}`.trim()];
  const entries = aclEntries(target, r.stdout);
  if (entries.length === 0) return ["no access entries found"];
  const problems: string[] = [];
  for (const { principal, rights } of entries) {
    const who = principal.toLowerCase();
    if (rights.includes("(I)")) problems.push(`inherited access for ${principal}`);
    else if (who !== user.name.toLowerCase() && who !== user.sid.toLowerCase()) {
      problems.push(`access for ${principal}`);
    }
  }
  return problems;
}

/** The `principal:(rights)` entries `icacls <target>` printed. */
function aclEntries(target: string, output: string): { principal: string; rights: string }[] {
  const entries: { principal: string; rights: string }[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (/^Successfully processed|^\s*$/.test(raw)) continue;
    const line = (raw.startsWith(target) ? raw.slice(target.length) : raw).trim();
    const colon = line.lastIndexOf(":(");
    if (colon <= 0) continue;
    entries.push({ principal: line.slice(0, colon), rights: line.slice(colon + 1) });
  }
  return entries;
}

/** Create `dir` (and its parents) and make it owner-only. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictToOwner(dir, "dir");
}

/**
 * Write a secret to `file` atomically and owner-only: an empty temporary
 * file beside it is restricted first, then filled, flushed and renamed into
 * place (the rename keeps its permissions). A crash leaves the old file or
 * the new one; the temporary file is removed on failure.
 */
export function writeSecretFile(file: string, data: string | Buffer): void {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    closeSync(openSync(temporary, "wx", 0o600));
    restrictToOwner(temporary, "file");
    const fd = openSync(temporary, "r+");
    try {
      writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
