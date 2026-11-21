/**
 * The SSH forward to a remote Sump (br-SUMP-000008-sJpO9KMY,
 * br-SUMP-000009-sJpO9KMY, REQ-000016-sJpO9KMY), decision D4: the app reaches
 * a remote Sump only through a port forward inside its own SSH connection,
 * never over direct HTTP and never with an `ssh` subprocess.
 *
 * One forward per remote Sump: an `ssh2` connection with the Sump's key and
 * the host key pinned at provisioning, keep-alives every 15 s (dropped after
 * 3 misses), and a listener on `127.0.0.1:0` (the OS picks the port, so it
 * never collides with the local Sump's, cttc BUG-000012) whose connections are
 * each forwarded to the Sump's `127.0.0.1:<sumpPort>` on its host.
 *
 * It counts as up only once `/health` answers through it. A failure to
 * establish closes everything and is reported; a drop moves the Sump to
 * `unreachable`; either way it tries again after 1 s, doubling to 5 minutes,
 * reset after a minute up, until stopped (FEAT-000017-sJpO9KMY). It lives
 * next to the Sump client: everything a Sump is asked still goes through the
 * client (br-CONN-000008-sJpO9KMY).
 */
import { createServer, type Server, type Socket } from "node:net";
import { Client } from "ssh2";
import type { Lifecycle } from "../catalog/lifecycle.js";
import { hostKeyFingerprint, KeyAgent, type SshTarget } from "../provision/ssh.js";
import { request } from "./client.js";
import { SumpHttpError } from "./errors.js";

/** What one forward needs: the Sump, its port on its host, and how to reach the host. */
export interface ForwardTarget {
  id: string;
  sumpPort: number;
  ssh: SshTarget;
}

/** Timing and wiring; tests shorten the delays. */
export interface ForwardOptions {
  lifecycle?: Lifecycle;
  /** Reconnect delays: the first, the cap, and how long up resets them. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  resetAfterMs?: number;
  /** How long the proof (`/health` through the forward) may take. */
  proofTimeoutMs?: number;
  keepaliveMs?: number;
  logger?: { info(message: string): void; warn(message: string): void };
}

/** One remote Sump's forward. */
export class SumpForward {
  /** The forward's local URL once it is up; `undefined` otherwise. */
  url: string | undefined;
  /** The last failure, for reports. */
  lastError: string | undefined;
  private client: Client | undefined;
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private delay: number;
  private upSince: number | undefined;
  private waiters: ((up: boolean) => void)[] = [];

  constructor(
    readonly target: ForwardTarget,
    private readonly options: ForwardOptions = {},
  ) {
    this.delay = options.baseDelayMs ?? 1_000;
  }

  /** True once `/health` answered through the forward, until it drops. */
  get up(): boolean {
    return this.url !== undefined;
  }

  /** Start connecting; reconnects on its own until `stop()`. */
  start(): void {
    this.stopped = false;
    void this.attempt();
  }

  /** Resolve with whether the forward is up, waiting up to `timeoutMs` for it. */
  waitUp(timeoutMs: number): Promise<boolean> {
    if (this.up) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = (up: boolean) => {
        clearTimeout(timer);
        resolve(up);
      };
      this.waiters.push(done);
    });
  }

  /** Close the listener and the connection, and cancel any reconnect. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.teardown();
    for (const waiter of this.waiters.splice(0)) waiter(false);
  }

  /** One attempt: connect, listen, prove; on failure or drop, schedule the next. */
  private async attempt(): Promise<void> {
    const log = this.options.logger ?? console;
    const { id } = this.target;
    try {
      const client = await this.connect();
      if (this.stopped) {
        client.end();
        return;
      }
      this.client = client;
      client.on("close", () => this.dropped());
      const port = await this.listen(client);
      const url = `http://127.0.0.1:${port}`;
      await this.prove(url);
      if (this.stopped) {
        this.teardown();
        return;
      }
      this.url = url;
      this.upSince = Date.now();
      this.lastError = undefined;
      log.info(`Sump ${id}: SSH forward up on ${url}`);
      this.options.lifecycle?.reachable(id, "SSH forward up");
      for (const waiter of this.waiters.splice(0)) waiter(true);
    } catch (error) {
      this.lastError = (error as Error).message;
      log.warn(`Sump ${id}: SSH forward not established (${this.lastError})`);
      this.teardown();
      this.options.lifecycle?.unreachable(id, `SSH forward not established: ${this.lastError}`);
      this.schedule();
    }
  }

  /** The SSH connection, with the pinned host key and keep-alives. */
  private connect(): Promise<Client> {
    const { ssh } = this.target;
    return new Promise((resolve, reject) => {
      const client = new Client();
      let refused: string | undefined;
      client
        .once("ready", () => resolve(client))
        .once("error", (error) => reject(refused ? new Error(refused) : error))
        .connect({
          host: ssh.host,
          port: ssh.port,
          username: ssh.username,
          agent: new KeyAgent(ssh.key),
          readyTimeout: ssh.readyTimeoutMs ?? 20_000,
          keepaliveInterval: this.options.keepaliveMs ?? 15_000,
          keepaliveCountMax: 3,
          hostVerifier: (key: Buffer) => {
            const seen = hostKeyFingerprint(key);
            if (ssh.knownHostKey && ssh.knownHostKey !== seen) {
              refused = `the host key of ${ssh.host} changed (${seen}); refusing to connect`;
              return false;
            }
            return true;
          },
        });
    });
  }

  /** A loopback listener on a port the OS picks, each connection forwarded over SSH. */
  private listen(client: Client): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        client.forwardOut(
          "127.0.0.1",
          socket.remotePort ?? 0,
          "127.0.0.1",
          this.target.sumpPort,
          (error, stream) => {
            if (error) {
              socket.destroy();
              return;
            }
            stream.on("error", () => socket.destroy());
            socket.pipe(stream).pipe(socket);
          },
        );
      });
      this.server = server;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      });
    });
  }

  /** `/health` through the forward: any answer proves it carries traffic. */
  private async prove(url: string): Promise<void> {
    try {
      await request({ name: this.target.id, baseUrl: url }, "GET", "/health", {
        timeoutMs: this.options.proofTimeoutMs ?? 5_000,
        logger: { warn: () => {} },
      });
    } catch (error) {
      if (!(error instanceof SumpHttpError)) throw error;
    }
  }

  /** The SSH connection closed: report, tear down, reconnect. */
  private dropped(): void {
    if (this.stopped) return;
    const wasUp = this.up;
    const upFor = this.upSince === undefined ? 0 : Date.now() - this.upSince;
    this.teardown();
    if (!wasUp) return; // A failing attempt schedules its own retry.
    (this.options.logger ?? console).warn(`Sump ${this.target.id}: SSH forward dropped`);
    this.options.lifecycle?.unreachable(this.target.id, "SSH forward dropped");
    if (upFor >= (this.options.resetAfterMs ?? 60_000))
      this.delay = this.options.baseDelayMs ?? 1_000;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.timer) return;
    const wait = this.delay;
    this.delay = Math.min(wait * 2, this.options.maxDelayMs ?? 300_000);
    (this.options.logger ?? console).info(`Sump ${this.target.id}: reconnecting in ${wait} ms`);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.attempt();
    }, wait);
    this.timer.unref?.();
  }

  private teardown(): void {
    this.url = undefined;
    this.upSince = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = undefined;
    const client = this.client;
    this.client = undefined;
    client?.removeAllListeners("close");
    client?.end();
  }
}

/** Every live remote Sump's forward (br-SUMP-000010-sJpO9KMY: kept in the background). */
export class Forwards {
  private readonly forwards = new Map<string, SumpForward>();

  constructor(private readonly options: ForwardOptions = {}) {}

  /** The Sump's forward, started if it was not already. */
  ensure(target: ForwardTarget): SumpForward {
    let forward = this.forwards.get(target.id);
    if (!forward) {
      forward = new SumpForward(target, this.options);
      this.forwards.set(target.id, forward);
      forward.start();
    }
    return forward;
  }

  /** The forward's URL when it is up. */
  urlOf(id: string): string | undefined {
    return this.forwards.get(id)?.url;
  }

  get(id: string): SumpForward | undefined {
    return this.forwards.get(id);
  }

  stop(id: string): void {
    this.forwards.get(id)?.stop();
    this.forwards.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.forwards.keys()]) this.stop(id);
  }
}
