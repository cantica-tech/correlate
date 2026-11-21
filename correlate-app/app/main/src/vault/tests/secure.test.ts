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
  it("writes a secret file atomically and owner-only", () => {
    const file = path.join(dir, "token.json");
    writeSecretFile(file, "first");
    writeSecretFile(file, "second");
    expect(readFileSync(file, "utf8")).toBe("second");
    expect(readdirSync(dir)).toEqual(["token.json"]);
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

/**
 * A fake Windows: records every command. `whoami` answers `user`; `icacls
 * <path>` answers the next of `listings` (the last one repeats), or an
 * owner-only listing; other icacls calls answer `set`.
 */
function fakeWindows(
  options: { user?: CommandResult; listings?: string[][]; set?: CommandResult } = {},
) {
  const calls: string[][] = [];
  const listings = [...(options.listings ?? [])];
  restore = overridePlatformForTests({
    windows: true,
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === "whoami") return options.user ?? WHOAMI;
      if (args.length > 1) return options.set ?? { status: 0, stdout: "", stderr: "" };
      const entries = (listings.length > 1 ? listings.shift() : listings[0]) ?? [
        "DESKTOP-1\\olivier:(F)",
      ];
      const [first, ...rest] = entries;
      const stdout = [
        `${args[0]} ${first}`,
        ...rest.map((e) => `        ${e}`),
        "",
        "Successfully processed 1 files; Failed processing 0 files",
      ].join("\r\n");
      return { status: 0, stdout, stderr: "" };
    },
  });
  return calls;
}

const WHOAMI = { status: 0, stdout: '"desktop-1\\olivier","S-1-5-21-1-2-3-1001"\r\n', stderr: "" };

describe("br-VAULT-000006-sJpO9KMY: owner-only on Windows, with icacls", () => {
  it("restricts the temporary file by SID before writing, checks it, then renames it", () => {
    const calls = fakeWindows();
    const file = path.join(dir, "secret");
    writeSecretFile(file, "s3cret");
    expect(calls[0]).toEqual(["whoami", "/user", "/fo", "csv", "/nh"]);
    const [, set, show] = calls as [string[], string[], string[]];
    expect(set[0]).toBe("icacls");
    expect(set[1]).toMatch(/secret\.[0-9a-f]{12}\.tmp$/);
    expect(set.slice(2)).toEqual(["/inheritance:r", "/grant:r", "*S-1-5-21-1-2-3-1001:(F)"]);
    expect(show).toEqual(["icacls", set[1]]);
    expect(calls.filter((c) => c.includes("/remove"))).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("s3cret");
  });

  it("removes the explicit entries a new file came with, then checks again", () => {
    const calls = fakeWindows({
      listings: [
        ["NT AUTHORITY\\SYSTEM:(F)", "BUILTIN\\Administrators:(F)", "DESKTOP-1\\olivier:(F)"],
        ["DESKTOP-1\\olivier:(F)"],
      ],
    });
    const file = path.join(dir, "secret");
    writeSecretFile(file, "x");
    const remove = calls.find((c) => c.includes("/remove")) as string[];
    expect(remove.slice(2)).toEqual(["/remove", "NT AUTHORITY\\SYSTEM", "BUILTIN\\Administrators"]);
  });

  it("grants folders to the SID with inheritance for what they will hold", () => {
    const calls = fakeWindows();
    ensurePrivateDir(path.join(dir, "vault"));
    expect(calls[1]?.slice(2)).toEqual([
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-21-1-2-3-1001:(OI)(CI)(F)",
    ]);
  });

  it("fails, and leaves nothing behind, when icacls fails", () => {
    fakeWindows({ set: { status: 5, stdout: "", stderr: "Access is denied." } });
    expect(() => writeSecretFile(path.join(dir, "secret"), "x")).toThrow(SecretFileError);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fails when another user's access cannot be removed", () => {
    fakeWindows({ listings: [["Everyone:(R)", "DESKTOP-1\\olivier:(F)"]] });
    expect(() => writeSecretFile(path.join(dir, "secret"), "x")).toThrow(/access for Everyone/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("fails when the user's SID cannot be read", () => {
    fakeWindows({ user: { status: 1, stdout: "", stderr: "nope" } });
    expect(() => ensurePrivateDir(path.join(dir, "v"))).toThrow(/SID/);
  });

  it("reports inherited entries and other users, and accepts the user alone", () => {
    fakeWindows({
      listings: [["NT AUTHORITY\\SYSTEM:(I)(F)", "BUILTIN\\Users:(RX)", "DESKTOP-1\\olivier:(F)"]],
    });
    expect(ownerOnlyProblems("C:\\Users\\olivier\\correlate app\\tokens.json")).toEqual([
      "inherited access for NT AUTHORITY\\SYSTEM",
      "access for BUILTIN\\Users",
    ]);
    restore?.();
    fakeWindows();
    expect(ownerOnlyProblems("C:\\vault\\a.key")).toEqual([]);
  });
});
