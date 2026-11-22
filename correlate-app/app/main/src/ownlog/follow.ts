/**
 * The local Sump's container log, followed into the own log while the app
 * runs (REQ-000048-sJpO9KMY, decided in FEAT-000050-sJpO9KMY): `docker logs
 * --follow --since 0s` on the container of compose project
 * `correlate-sump-local`, service `sump`; each line classified
 * (`classify.ts`). No local Sump, or Docker gone: tried again later, quietly.
 * A remote Sump's log is fetched only by Ship Logs (Item 51).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { LOCAL_PROJECT } from "../provision/local.js";
import { isRoutineSumpLine } from "./classify.js";
import type { OwnLog } from "./ownlog.js";

/** What following needs: running a command, and its lines. */
export interface FollowDeps {
  /** The local Sump's container id, or null when it is not running. */
  container: () => Promise<string | null>;
  /** Follow `container`'s log from now: each line, then the end. */
  follow: (container: string, onLine: (line: string) => void, onEnd: () => void) => () => void;
  retryMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
}

/** One line of the Sump into the own log, at its level. */
export function sumpLine(log: OwnLog, line: string): void {
  if (!line.trim()) return;
  log.write(isRoutineSumpLine(line) ? "INFO" : "ERROR", `sump: ${line}`);
}

/** Follow the local Sump into `log` until the returned stop is called. */
export function followLocalSump(log: OwnLog, deps: FollowDeps): () => void {
  let stopped = false;
  let stopFollow: (() => void) | null = null;
  const retry = () => {
    if (stopped) return;
    (deps.setTimer ?? ((run, ms) => setTimeout(run, ms).unref()))(attempt, deps.retryMs ?? 30_000);
  };
  const attempt = () => {
    if (stopped) return;
    void deps.container().then(
      (id) => {
        if (stopped) return;
        if (!id) return retry();
        stopFollow = deps.follow(
          id,
          (line) => sumpLine(log, line),
          () => {
            stopFollow = null;
            retry();
          },
        );
      },
      () => retry(),
    );
  };
  attempt();
  return () => {
    stopped = true;
    stopFollow?.();
  };
}

/** The real Docker: the container by its compose labels, its log by `docker logs`. */
export const dockerFollow: Pick<FollowDeps, "container" | "follow"> = {
  container: () =>
    new Promise((resolve) => {
      const child = spawn("docker", [
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${LOCAL_PROJECT}`,
        "--filter",
        "label=com.docker.compose.service=sump",
      ]);
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => resolve(null));
      child.on("close", () => resolve(out.trim().split("\n")[0] || null));
    }),
  follow: (container, onLine, onEnd) => {
    const child: ChildProcess = spawn("docker", ["logs", "--follow", "--since", "0s", container]);
    let rest = "";
    const read = (chunk: Buffer) => {
      const lines = (rest + String(chunk)).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) onLine(line.replace(/\r$/, ""));
    };
    // The Sump writes to both; its level, not the stream, says what a line is.
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", onEnd);
    child.on("close", onEnd);
    return () => child.kill();
  },
};
