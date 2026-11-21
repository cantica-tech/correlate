import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog } from "../../catalog/catalog.js";
import { Lifecycle } from "../../catalog/lifecycle.js";
import { ActiveSumps } from "../../catalog/windows.js";
import { SessionTokens } from "../../sump/tokens.js";
import { Vault } from "../../vault/vault.js";
import { checkRemoteDetails } from "../plan.js";
import { type PendingSump, provisionRemote, type RemoteContext, sshKeyIdFor } from "../remote.js";
import type { RemoteResult, RemoteShell, SshTarget } from "../ssh.js";

// REQ-000014-sJpO9KMY Requirements 4 and 5 (br-SUMP-000007-sJpO9KMY):
// provisioning a Sump on a host over SSH, with the host faked.

const quiet = { info: () => {}, warn: () => {} };
const ok = (stdout = ""): RemoteResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string): RemoteResult => ({ code: 1, stdout: "", stderr, timedOut: false });

let dir: string;
let catalog: Catalog;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "remote-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(() => {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake host: `answer` decides each command's result; everything is recorded. */
function fakeHost(answer: (command: string, call: number) => RemoteResult) {
  const commands: { command: string; input?: string }[] = [];
  const targets: SshTarget[] = [];
  let closed = 0;
  const connect = async (target: SshTarget): Promise<RemoteShell> => {
    targets.push(target);
    return {
      hostKey: "SHA256:host",
      exec: async (command, options = {}) => {
        commands.push({
          command,
          input: typeof options.input === "string" ? options.input : undefined,
        });
        return answer(command, commands.length);
      },
      probePort: async () => "open" as const,
      close: () => {
        closed += 1;
      },
    };
  };
  return { connect, commands, targets, closed: () => closed };
}

const healthyHost = (command: string) => {
  if (command.includes("python -c")) return ok("True\n");
  // The Docker socket's group, read with the Sump image (REQ-000024-sJpO9KMY).
  if (command.includes("'%g'")) return ok("999\n");
  return ok();
};

function context(
  connect: RemoteContext["connect"],
  extra: Partial<RemoteContext> = {},
): RemoteContext {
  const vault = new Vault(path.join(dir, "vault"), undefined, {
    scrypt: { N: 2 ** 10, r: 8, p: 1 },
    logger: quiet,
  });
  vault.create("a passphrase", "a passphrase");
  return {
    run: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    lifecycle: new Lifecycle(catalog, undefined, { info: () => {} }),
    tokens: new SessionTokens(),
    vault,
    env: { CORRELATE_USER: "olivier", CORRELATE_SUMP_IMAGE: "correlate-sump:dev" },
    appVersion: "0.1.0",
    catalog,
    active: new ActiveSumps(catalog),
    connect,
    pending: new Map<string, PendingSump>(),
    healthTimeoutMs: 1_000,
    pollMs: 10,
    logger: quiet,
    ...extra,
  };
}

const details = checkRemoteDetails({ sshTarget: "ops@box.example.org", sumpPort: 8765 });

describe("REQ-000014-sJpO9KMY: provisioning on a host over SSH", () => {
  it("prepares the host, starts the Sump, sets the owner and waits for the first connect", async () => {
    const host = fakeHost(healthyHost);
    const ctx = context(host.connect);
    ctx.active?.open(1);
    const result = await provisionRemote(ctx, details);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(host.targets[0]).toMatchObject({ host: "box.example.org", port: 22, username: "ops" });
    const run = host.commands.map((c) => c.command);
    expect(run[0]).toBe("docker version --format '{{.Server.Version}}'");
    expect(run[1]).toBe("mkdir -p ~/.correlate-sump && chmod 700 ~/.correlate-sump");
    expect(run[2]).toBe(
      "docker image inspect 'correlate-sump:dev' >/dev/null 2>&1 || docker pull 'correlate-sump:dev'",
    );
    expect(run[3]).toBe(
      "docker 'run' '--rm' '--entrypoint' 'stat' '-v' '/var/run/docker.sock:/var/run/docker.sock' 'correlate-sump:dev' '-c' '%g' '/var/run/docker.sock'",
    );
    expect(run[4]).toBe("cat > ~/.correlate-sump/docker-compose.yml");
    expect(host.commands[4]?.input).toContain('"127.0.0.1:8765:8765"');
    // The host's Docker socket, with the group read on the host (REQ-000024-sJpO9KMY).
    expect(host.commands[4]?.input).toContain("      - /var/run/docker.sock:/var/run/docker.sock");
    expect(host.commands[4]?.input).toContain('    group_add:\n      - "999"');
    expect(run[5]).toBe(
      "docker compose -f ~/.correlate-sump/docker-compose.yml -p correlate-sump up -d",
    );
    expect(run.at(-1)).toContain("set-owner --user 'olivier'");
    expect(host.commands.at(-1)?.input).toMatch(/^ssh-ed25519 AAAA\S+ correlate-app\n$/);
    expect(ctx.lifecycle.get(result.id)?.state).toBe("provisioning");
    expect(ctx.pending.get(result.id)).toEqual({
      id: result.id,
      details,
      hostKey: "SHA256:host",
      sshKeyId: "identity",
    });
    expect(catalog.list()).toEqual([]); // recorded only after its first connect
    expect(ctx.active?.get(1)).toBe("local");
    expect(host.closed()).toBe(1);
  });

  it("streams the image over SSH when the host cannot pull it", async () => {
    let ups = 0;
    const host = fakeHost((command) => {
      if (command.includes("docker pull")) return fail("pull access denied for correlate-sump");
      if (command.endsWith(" up -d")) ups += 1;
      return healthyHost(command);
    });
    const streamed: string[] = [];
    const ctx = context(host.connect, {
      streamImage: async (_shell, image) => {
        streamed.push(image);
      },
    });
    const result = await provisionRemote(ctx, details);
    expect(result.ok).toBe(true);
    expect(streamed).toEqual(["correlate-sump:dev"]);
    // Streamed before the socket's group is read and the Sump started, once.
    expect(ups).toBe(1);
  });

  it("uses a key imported for this Sump, kept under its own vault id", async () => {
    const host = fakeHost(healthyHost);
    const ctx = context(host.connect);
    const keyPem = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    const result = await provisionRemote(ctx, details, { keyPem });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ctx.pending.get(result.id)?.sshKeyId).toBe(sshKeyIdFor(result.id));
    expect(ctx.vault?.get(sshKeyIdFor(result.id))).toBe(keyPem);
  });
});

describe("br-SUMP-000007-sJpO9KMY: a failed remote provisioning leaves nothing behind", () => {
  it.each([
    [
      "check Docker on the host",
      (c: string) => (c.startsWith("docker version") ? fail("docker: not found") : healthyHost(c)),
    ],
    [
      "make you its owner",
      (c: string) =>
        c.includes("set-owner") ? fail("alice already owns this Sump") : healthyHost(c),
    ],
    [
      "find the Docker socket's group",
      (c: string) => (c.includes("'%g'") ? ok("stat: cannot stat\n") : healthyHost(c)),
    ],
    [
      "wait for the Sump",
      (c: string) => (c.includes("python -c") ? ok("False\n") : healthyHost(c)),
    ],
  ])("at %s: imported key deleted, Sump retired, no window moved", async (step, answer) => {
    const host = fakeHost(answer);
    const ctx = context(host.connect);
    ctx.active?.open(1);
    const keyPem = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    const result = await provisionRemote(ctx, details, { keyPem });
    expect(result).toMatchObject({ ok: false, step });
    const states = ctx.lifecycle.states();
    expect(states).toHaveLength(1);
    expect(states[0]?.state).toBe("retired");
    const id = states[0]?.id as string;
    expect(ctx.vault?.has(sshKeyIdFor(id))).toBe(false);
    expect(ctx.pending.size).toBe(0);
    expect(ctx.active?.get(1)).toBe("local");
    expect(host.closed()).toBe(1);
    // Nothing was started before the compose file: nothing to take down.
    const before = ["check Docker on the host", "find the Docker socket's group"];
    if (!before.includes(step)) {
      expect(host.commands.at(-1)?.command).toMatch(/ down$/);
    } else {
      expect(host.commands.some((c) => c.command.endsWith(" up -d"))).toBe(false);
    }
  });

  it("fails at the SSH connection without touching the host", async () => {
    const ctx = context(async () => {
      throw new Error("All configured authentication methods failed");
    });
    const result = await provisionRemote(ctx, details);
    expect(result).toEqual({
      ok: false,
      step: "connect over SSH",
      message: "All configured authentication methods failed",
    });
  });
});
