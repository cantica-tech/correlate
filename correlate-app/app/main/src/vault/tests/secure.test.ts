import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandResult,
  ensurePrivateDir,
  overridePlatformForTests,
  ownerOnlyProblems,
  SecretFileError,
  writeSecretFile,
} from "../secure.js";

// br-VAULT-000006-sJpO9KMY (REQ-000009-sJpO9KMY Requirement 2): secret files
// are owner-only on every system.

const WINDOWS = process.platform === "win32";
let dir: string;
let restore: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "secure-test-"));
});
afterEach(() => {
  restore?.();
  restore = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe("br-VAULT-000006-sJpO9KMY: owner-only on this system, for real", () => {
  it("writes a secret file atomically and owner-only", async () => {
    const file = path.join(dir, "token.json");
    writeSecretFile(file, "first");
    writeSecretFile(file, "second");
    expect(readFileSync(file, "utf8")).toBe("second");
    expect(readdirSync(dir)).toEqual(["token.json"]);
    if (WINDOWS) {
      const { spawnSync } = await import("node:child_process");
      for (const [cmd, args] of [
        ["whoami", ["/user", "/fo", "csv", "/nh"]],
        ["icacls", [file]],
      ] as const) {
        const r = spawnSync(cmd, [...args], { encoding: "utf8" });
        console.log(`DIAG ${cmd}: ${JSON.stringify(r.stdout)} ${JSON.stringify(r.stderr)}`);
      }
      console.log(
        `DIAG file: ${JSON.stringify(file)} problems: ${JSON.stringify(ownerOnlyProblems(file))}`,
      );
    }
    expect(ownerOnlyProblems(file)).toEqual([]);
  });

  it("makes a folder owner-only", () => {
    const sub = path.join(dir, "a", "b");
    ensurePrivateDir(sub);
    expect(ownerOnlyProblems(sub)).toEqual([]);
  });

  it.skipIf(WINDOWS)("reports a file others can read", () => {
    const file = path.join(dir, "wide");
    writeSecretFile(file, "x");
    chmodSync(file, 0o644);
    expect(ownerOnlyProblems(file)).toEqual(["group or others have access (mode 644)"]);
  });
});

/** A fake Windows: records every command and answers from `answers`. */
function fakeWindows(answers: Record<string, CommandResult>) {
  const calls: string[][] = [];
  restore = overridePlatformForTests({
    windows: true,
    run: (command, args) => {
      calls.push([command, ...args]);
      const key = `${command} ${args.length === 1 ? "show" : args[0] === "/user" ? "user" : "set"}`;
      return answers[key] ?? { status: 0, stdout: "", stderr: "" };
    },
  });
  return calls;
}

const WHOAMI = { status: 0, stdout: '"desktop-1\\olivier","S-1-5-21-1-2-3-1001"\r\n', stderr: "" };

describe("br-VAULT-000006-sJpO9KMY: owner-only on Windows, with icacls", () => {
  it("restricts the temporary file by SID before writing, then renames it", () => {
    const calls = fakeWindows({ "whoami user": WHOAMI });
    const file = path.join(dir, "secret");
    writeSecretFile(file, "s3cret");
    expect(calls[0]).toEqual(["whoami", "/user", "/fo", "csv", "/nh"]);
    const icacls = calls[1] as string[];
    expect(icacls[0]).toBe("icacls");
    expect(icacls[1]).toMatch(/secret\.[0-9a-f]{12}\.tmp$/);
    expect(icacls.slice(2)).toEqual(["/inheritance:r", "/grant:r", "*S-1-5-21-1-2-3-1001:(F)"]);
    expect(calls).toHaveLength(2);
    expect(readFileSync(file, "utf8")).toBe("s3cret");
  });

  it("grants folders to the SID with inheritance for what they will hold", () => {
    const calls = fakeWindows({ "whoami user": WHOAMI });
    ensurePrivateDir(path.join(dir, "vault"));
    expect(calls[1]?.slice(2)).toEqual([
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-1-2-3-1001:(OI)(CI)(F)",
    ]);
  });

  it("fails, and leaves nothing behind, when icacls fails", () => {
    fakeWindows({
      "whoami user": WHOAMI,
      "icacls set": { status: 5, stdout: "", stderr: "Access is denied." },
    });
    expect(() => writeSecretFile(path.join(dir, "secret"), "x")).toThrow(SecretFileError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fails when the user's SID cannot be read", () => {
    fakeWindows({ "whoami user": { status: 1, stdout: "", stderr: "nope" } });
    expect(() => ensurePrivateDir(path.join(dir, "v"))).toThrow(/SID/);
  });

  it("accepts a file only the current user can access", () => {
    const target = "C:\\Users\\olivier\\vault\\a.key";
    fakeWindows({
      "whoami user": WHOAMI,
      "icacls show": {
        status: 0,
        stdout: `${target} DESKTOP-1\\olivier:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n`,
        stderr: "",
      },
    });
    expect(ownerOnlyProblems(target)).toEqual([]);
  });

  it("reports inherited entries and other users", () => {
    const target = "C:\\Users\\olivier\\AppData\\Roaming\\correlate app\\tokens.json";
    fakeWindows({
      "whoami user": WHOAMI,
      "icacls show": {
        status: 0,
        stdout: [
          `${target} NT AUTHORITY\\SYSTEM:(I)(F)`,
          "        BUILTIN\\Users:(RX)",
          "        DESKTOP-1\\olivier:(F)",
          "",
          "Successfully processed 1 files; Failed processing 0 files",
        ].join("\r\n"),
        stderr: "",
      },
    });
    expect(ownerOnlyProblems(target)).toEqual([
      "inherited access for NT AUTHORITY\\SYSTEM",
      "access for BUILTIN\\Users",
    ]);
  });
});
