/**
 * Running local commands for provisioning (REQ-000014-sJpO9KMY): always an
 * argument list, never a shell string, so no value can become a command
 * (the lesson of br-SUMP-000006-sJpO9KMY), and always with a time limit
 * (br-CONN-000005-sJpO9KMY's spirit, for Docker).
 */
import { spawn } from "node:child_process";

/** How a command ended. */
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the time limit ended it. */
  timedOut: boolean;
}

/** Options for one command. */
export interface RunOptions {
  /** Ended after this many milliseconds (60 s by default). */
  timeoutMs?: number;
  /** Written to the command's standard input. */
  input?: string | Buffer;
  /** Working directory. */
  cwd?: string;
}

/** Runs a command; injectable so tests can check what would run. */
export type Runner = (
  command: string,
  args: string[],
  options?: RunOptions,
) => Promise<CommandResult>;

/** The real runner: `spawn` without a shell, killed at its time limit. */
export const runCommand: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });

/** A step of provisioning that failed; `step` says which. */
export class ProvisionError extends Error {
  override readonly name = "ProvisionError";

  constructor(
    readonly step: string,
    message: string,
  ) {
    super(`${step}: ${message}`);
  }
}

/** Run a command and fail with `step` unless it exits 0. */
export async function mustRun(
  run: Runner,
  step: string,
  command: string,
  args: string[],
  options?: RunOptions,
): Promise<CommandResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const why = result.timedOut
      ? "timed out"
      : (result.stderr || result.stdout).trim() || `exit ${result.code}`;
    throw new ProvisionError(step, why);
  }
  return result;
}
