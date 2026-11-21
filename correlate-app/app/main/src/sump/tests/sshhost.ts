/**
 * An SSH host in the test process (`ssh2`'s `Server`): it accepts one key,
 * answers `exec` with `reply`, and forwards `direct-tcpip` to 127.0.0.1, so
 * provisioning and the SSH forward can be tested end to end without a real
 * host.
 */
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type AddressInfo, connect as tcpConnect } from "node:net";
import { type Connection, Server, utils } from "ssh2";
import { publicKeyLine } from "../../identity/sshkey.js";

const HOST_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
}) as string;

/** A running test SSH host. */
export interface SshHost {
  port: number;
  /** Destination ports forwarded so far. */
  forwarded: number[];
  /** Commands run so far. */
  commands: string[];
  /** Drop every connected client. */
  dropAll(): void;
  close(): void;
}

/** Answers a command: exit code and standard output. */
export type Reply = (command: string, input: string) => [number, string];

/** Start a host accepting `allowed`; `reply` answers commands (exit 0 by default). */
export async function sshHost(allowed: KeyObject, reply: Reply = () => [0, ""]): Promise<SshHost> {
  const parsed = utils.parseKey(publicKeyLine(allowed));
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key) throw new Error("no key");
  const clients = new Set<Connection>();
  const forwarded: number[] = [];
  const commands: string[] = [];
  const server = new Server({ hostKeys: [HOST_PEM] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client
      .on("authentication", (ctx) => {
        const ok =
          ctx.method === "publickey" &&
          ctx.key.algo === key.type &&
          Buffer.compare(ctx.key.data, key.getPublicSSH()) === 0 &&
          (!ctx.signature || key.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo));
        if (ok) ctx.accept();
        else ctx.reject(["publickey"]);
      })
      .on("ready", () => {
        client.on("session", (accept) => {
          accept().on("exec", (acceptExec, _reject, info) => {
            commands.push(info.command);
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
        client.on("tcpip", (accept, reject, info) => {
          forwarded.push(info.destPort);
          // As OpenSSH does: connect first, refuse the channel if that fails.
          const socket = tcpConnect(info.destPort, "127.0.0.1");
          socket.once("error", () => reject());
          socket.once("connect", () => {
            socket.removeAllListeners("error");
            const stream = accept();
            socket.on("error", () => stream.close());
            stream.on("error", () => socket.destroy());
            stream.pipe(socket).pipe(stream);
          });
        });
      })
      .on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    forwarded,
    commands,
    dropAll: () => {
      for (const c of clients) c.end();
    },
    close: () => {
      for (const c of clients) c.end();
      server.close();
    },
  };
}

/** Commands of provisioning answered as a healthy host would. */
export const healthyHost: Reply = (command) => {
  if (command.includes("python -c")) return [0, "True\n"];
  // The Docker socket's group, read with the Sump image (REQ-000024-sJpO9KMY).
  if (command.includes("'%g'")) return [0, "999\n"];
  return [0, ""];
};
