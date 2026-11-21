/**
 * An SSH connection to a remote host, in the main process (decision D4: an
 * SSH library, never the `ssh` command), for provisioning
 * (REQ-000014-sJpO9KMY Requirement 4) and, with Item 17, the forward.
 *
 * - The private key never leaves memory in another format: a small agent
 *   signs `ssh2`'s authentication with Node's crypto, from the key the vault
 *   holds (any type the key policy accepts).
 * - The host's key is accepted on first use and returned as a SHA-256
 *   fingerprint; given a remembered fingerprint, any other key is refused.
 * - Commands run with a time limit and optional standard input (a string, a
 *   buffer or a stream, such as `docker save` for `docker load`).
 */
import { createHash, type KeyObject, sign } from "node:crypto";
import type { Readable } from "node:stream";
import { BaseAgent, Client, type ParsedKey, type SigningRequestOptions } from "ssh2";
import { publicKeyLine, sshKeyType } from "../identity/sshkey.js";

/** How a remote command ended. */
export interface RemoteResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** A shell on a remote host: what provisioning needs from SSH. */
export interface RemoteShell {
  /** The host key's fingerprint (`SHA256:...`), as accepted. */
  hostKey: string;
  exec(
    command: string,
    options?: { input?: string | Buffer | Readable; timeoutMs?: number },
  ): Promise<RemoteResult>;
  close(): void;
}

/** Where and as whom to connect. */
export interface SshTarget {
  host: string;
  port: number;
  username: string;
  key: KeyObject;
  /** The fingerprint remembered for this host; another key is refused. */
  knownHostKey?: string;
  /** How long to wait for the connection; 20 s. */
  readyTimeoutMs?: number;
}

/** Opens a remote shell; injectable so tests can fake a host. */
export type SshConnect = (target: SshTarget) => Promise<RemoteShell>;

/** A host key's SHA-256 fingerprint, as `ssh-keygen -l` prints it. */
export function hostKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Signs `ssh2`'s authentication with a key held in memory. */
export class KeyAgent extends BaseAgent<string> {
  constructor(private readonly key: KeyObject) {
    super();
  }

  getIdentities(callback: (err: Error | undefined, keys?: string[]) => void): void {
    callback(undefined, [publicKeyLine(this.key)]);
  }

  sign(
    _pubKey: string | Buffer | ParsedKey,
    data: Buffer,
    options: SigningRequestOptions | ((err?: Error, signature?: Buffer) => void),
    cb?: (err?: Error, signature?: Buffer) => void,
  ): void {
    const callback = typeof options === "function" ? options : cb;
    const hash = typeof options === "function" ? undefined : options?.hash;
    try {
      const type = sshKeyType(this.key);
      let signature: Buffer;
      if (type === "ssh-ed25519") signature = sign(null, data, this.key);
      else if (type === "ssh-rsa") signature = sign(hash ?? "sha512", data, this.key);
      else {
        // ECDSA: DER, which ssh2 turns into SSH's (r, s) itself.
        const curveHash = { "ecdsa-sha2-nistp256": "sha256", "ecdsa-sha2-nistp384": "sha384" }[
          type
        ];
        signature = sign(curveHash ?? "sha512", data, this.key);
      }
      callback?.(undefined, signature);
    } catch (error) {
      callback?.(error as Error);
    }
  }
}

/** The real connection, with `ssh2`. */
export const connectSsh: SshConnect = (target) =>
  new Promise((resolve, reject) => {
    const client = new Client();
    let hostKey = "";
    let refused: string | undefined;
    client
      .on("ready", () => {
        resolve({
          hostKey,
          exec: (command, options = {}) => execOn(client, command, options),
          close: () => client.end(),
        });
      })
      .on("error", (error) => {
        reject(refused ? new Error(refused) : error);
      })
      .connect({
        host: target.host,
        port: target.port,
        username: target.username,
        agent: new KeyAgent(target.key),
        readyTimeout: target.readyTimeoutMs ?? 20_000,
        hostVerifier: (key: Buffer) => {
          hostKey = hostKeyFingerprint(key);
          if (target.knownHostKey && target.knownHostKey !== hostKey) {
            refused = `the host key of ${target.host} changed (${hostKey}, expected ${target.knownHostKey}); refusing to connect`;
            return false;
          }
          return true;
        },
      });
  });

/** Run one command on `client`, with a time limit and optional input. */
function execOn(
  client: Client,
  command: string,
  options: { input?: string | Buffer | Readable; timeoutMs?: number },
): Promise<RemoteResult> {
  return new Promise((resolve) => {
    client.exec(command, (error, stream) => {
      if (error) {
        resolve({ code: null, stdout: "", stderr: error.message, timedOut: false });
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stream.close();
      }, options.timeoutMs ?? 60_000);
      stream.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      stream.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      stream.on("close", (code: number | null) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? null : (code ?? null), stdout, stderr, timedOut });
      });
      const input = options.input;
      if (input === undefined) stream.end();
      else if (typeof input === "string" || Buffer.isBuffer(input)) stream.end(input);
      else input.pipe(stream);
    });
  });
}

/** Quote a value for a POSIX shell: only ever used on validated values. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
