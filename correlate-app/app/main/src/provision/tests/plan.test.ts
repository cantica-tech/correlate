import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../../catalog/catalog.js";
import { checkRemoteDetails, DetailsError, PROVISIONING_NOTICES, startupPlan } from "../plan.js";
import { mustRun, ProvisionError, type Runner, runCommand } from "../runner.js";

// br-CONN-000006-sJpO9KMY, br-CONN-000003-sJpO9KMY (REQ-000014-sJpO9KMY
// Requirements 1 and 2): what to offer at startup, and a new Sump's details.

let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "plan-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

const docker =
  (up: boolean): Runner =>
  async () => ({ code: up ? 0 : 1, stdout: up ? "29.0.0\n" : "", stderr: "", timedOut: false });

describe("br-CONN-000006-sJpO9KMY: the startup plan", () => {
  it("first run with Docker: local, remote and skip", async () => {
    expect(await startupPlan(catalog, docker(true))).toEqual({
      firstRun: true,
      docker: true,
      offers: ["local", "remote", "skip"],
      notices: PROVISIONING_NOTICES,
    });
  });

  it("says the Sump gets its host's Docker socket (REQ-000024-sJpO9KMY)", async () => {
    const { notices } = await startupPlan(catalog, docker(true));
    expect(notices).toEqual([expect.stringContaining("Docker socket")]);
    expect(notices[0]).toContain("any Docker command");
  });

  it("first run without Docker: remote only, no skip", async () => {
    expect((await startupPlan(catalog, docker(false))).offers).toEqual(["remote"]);
  });

  it("later runs never offer skip", async () => {
    catalog.recordConnect({ kind: "local", sumpPort: 8765 });
    expect((await startupPlan(catalog, docker(true))).offers).toEqual(["local", "remote"]);
    expect((await startupPlan(catalog, docker(false))).offers).toEqual(["remote"]);
  });

  it("asks Docker with an argument list and a time limit", async () => {
    const calls: unknown[] = [];
    await startupPlan(catalog, async (command, args, options) => {
      calls.push([command, args, options]);
      return { code: 0, stdout: "29\n", stderr: "", timedOut: false };
    });
    expect(calls).toEqual([
      ["docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 }],
    ]);
  });
});

describe("br-CONN-000003-sJpO9KMY: a new Sump's details", () => {
  it.each([
    ["box", { sshTarget: "box", sshPort: 22, sumpPort: 8765 }],
    ["ops@box.example.org", { sshTarget: "ops@box.example.org", sshPort: 22, sumpPort: 8765 }],
    ["root@[2001:db8::1]", { sshTarget: "root@[2001:db8::1]", sshPort: 22, sumpPort: 8765 }],
  ])("accepts %s", (target, expected) => {
    expect(checkRemoteDetails({ sshTarget: target })).toEqual(expected);
  });

  it("takes ports as numbers or digits", () => {
    expect(checkRemoteDetails({ sshTarget: "box", sshPort: "2222", sumpPort: 9000 })).toMatchObject(
      {
        sshPort: 2222,
        sumpPort: 9000,
      },
    );
  });

  it.each([
    [{}],
    [{ sshTarget: "box; rm -rf /" }],
    [{ sshTarget: "$(whoami)@box" }],
    [{ sshTarget: "box -oProxyCommand=x" }],
    [{ sshTarget: "-oProxyCommand=x" }],
    [{ sshTarget: "a@b@c" }],
    [{ sshTarget: "box", sshPort: 0 }],
    [{ sshTarget: "box", sumpPort: 70000 }],
    [{ sshTarget: "box", sshPort: "22x" }],
  ])("refuses %j before anything runs", (input) => {
    expect(() => checkRemoteDetails(input)).toThrow(DetailsError);
  });
});

describe("running commands", () => {
  it("passes arguments without a shell", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "console.log(process.argv[1])",
      "a; echo b",
    ]);
    expect(result).toMatchObject({ code: 0, stdout: "a; echo b\n", timedOut: false });
  });

  it("ends a command at its time limit", async () => {
    const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 100,
    });
    expect(result.timedOut).toBe(true);
    await expect(mustRun(async () => result, "start the Sump", "docker", [])).rejects.toThrow(
      new ProvisionError("start the Sump", "timed out"),
    );
  });

  it("reports a missing command", async () => {
    const result = await runCommand("no-such-command-correlate", []);
    expect(result.code).toBeNull();
  });
});
