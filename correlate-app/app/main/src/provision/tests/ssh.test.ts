import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { Server, utils } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";
import { publicKeyLine } from "../../identity/sshkey.js";
import { connectSsh, shellQuote } from "../ssh.js";

// REQ-000014-sJpO9KMY Requirement 4: the app's SSH connection, against a real
// SSH server running in this process (ssh2's Server).

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function hostKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem",
  }) as string;
}

/** An SSH server accepting `allowed` for "ops", answering each exec with `reply`. */
async function sshServer(
  allowed: KeyObject,
  reply: (command: string, input: string) => [number, string],
) {
  const expected = utils.parseKey(publicKeyLine(allowed));
  if (expected instanceof Error) throw expected;
  const key = Array.isArray(expected) ? expected[0] : expected;
  const server = new Server({ hostKeys: [hostKeyPem()] }, (client) => {
    client
      .on("authentication", (ctx) => {
        if (
          ctx.method === "publickey" &&
          ctx.username === "ops" &&
          ctx.key.algo === key?.type &&
          Buffer.compare(ctx.key.data, key.getPublicSSH()) === 0 &&
          (!ctx.signature || key.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo))
        ) {
          ctx.accept();
        } else {
          ctx.reject(["publickey"]);
        }
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          accept().on("exec", (acceptExec, _reject, info) => {
            const stream = acceptExec();
            let input = "";
            stream.on("data", (chunk: Buffer) => {
              input += chunk.toString();
            });
            stream.on("end", () => {
              const [code, out] = reply(info.command, input);
              stream.write(out);
              stream.exit(code);
              stream.end();
            });
          });
        });
      })
      .on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const KEYS: Record<string, () => KeyObject> = {
  ed25519: () => generateKeyPairSync("ed25519").privateKey,
  "ecdsa p256": () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
  "ecdsa p384": () => generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey,
  "rsa 3072": () => generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey,
};

describe("the app's SSH connection", () => {
  it.each(Object.keys(KEYS))(
    "logs in with a %s key and runs a command with input",
    async (kind) => {
      const key = (KEYS[kind] as () => KeyObject)();
      const port = await sshServer(key, (command, input) => [0, `${command}|${input}`]);
      const shell = await connectSsh({ host: "127.0.0.1", port, username: "ops", key });
      try {
        expect(shell.hostKey).toMatch(/^SHA256:/);
        expect(await shell.exec("cat", { input: "hello" })).toEqual({
          code: 0,
          stdout: "cat|hello",
          stderr: "",
          timedOut: false,
        });
        const streamed = await shell.exec("load", { input: Readable.from(["a", "b"]) });
        expect(streamed.stdout).toBe("load|ab");
      } finally {
        shell.close();
      }
    },
    30_000,
  );

  it("is refused with a key the host does not accept", async () => {
    const port = await sshServer(KEYS.ed25519?.() as KeyObject, () => [0, ""]);
    await expect(
      connectSsh({ host: "127.0.0.1", port, username: "ops", key: KEYS.ed25519?.() as KeyObject }),
    ).rejects.toThrow();
  });

  it("pins the host key: the same one is accepted, another refused", async () => {
    const key = KEYS.ed25519?.() as KeyObject;
    const port = await sshServer(key, () => [0, ""]);
    const first = await connectSsh({ host: "127.0.0.1", port, username: "ops", key });
    first.close();
    const again = await connectSsh({
      host: "127.0.0.1",
      port,
      username: "ops",
      key,
      knownHostKey: first.hostKey,
    });
    again.close();
    await expect(
      connectSsh({ host: "127.0.0.1", port, username: "ops", key, knownHostKey: "SHA256:other" }),
    ).rejects.toThrow(/host key of 127.0.0.1 changed/);
  });

  it("reports a command's exit code and quotes values for the shell", async () => {
    const key = KEYS.ed25519?.() as KeyObject;
    const port = await sshServer(key, () => [3, "no"]);
    const shell = await connectSsh({ host: "127.0.0.1", port, username: "ops", key });
    expect((await shell.exec("false")).code).toBe(3);
    shell.close();
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});
