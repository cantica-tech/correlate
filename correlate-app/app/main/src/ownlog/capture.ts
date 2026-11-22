/**
 * What the own log holds (REQ-000048-sJpO9KMY, decided in
 * FEAT-000050-sJpO9KMY): every line the main process logs, through the
 * console (status-bar notices included: `Notifications` logs each one), and
 * the windows' uncaught errors, each leveled.
 */
import type { Level, OwnLog } from "./ownlog.js";

/** The console methods and the level each is written at. */
const METHODS: [keyof Console & ("log" | "info" | "warn" | "error" | "debug"), Level][] = [
  ["debug", "DEBUG"],
  ["log", "INFO"],
  ["info", "INFO"],
  ["warn", "WARN"],
  ["error", "ERROR"],
];

/** A console argument as text: errors with their stack. */
function text(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Copy the console's lines into `log`, as well as printing them; the undo. */
export function captureConsole(log: OwnLog, target: Console = console): () => void {
  const originals = METHODS.map(([name]) => [name, target[name]] as const);
  for (const [name, level] of METHODS) {
    const original = target[name].bind(target);
    target[name] = (...args: unknown[]) => {
      original(...args);
      log.write(level, args.map(text).join(" "));
    };
  }
  return () => {
    for (const [name, fn] of originals) target[name] = fn as never;
  };
}

/** A window's console message, as Electron's `console-message` event has it. */
export interface WindowMessage {
  level?: unknown;
  message?: unknown;
  lineNumber?: unknown;
  sourceId?: unknown;
}

/**
 * A window's console message as an own-log line: errors only (an uncaught
 * error is one), with where it came from; null for any other level.
 */
export function windowError(event: WindowMessage): string | null {
  if (event.level !== "error" && event.level !== 3) return null;
  const source = typeof event.sourceId === "string" ? event.sourceId : "";
  const where = source ? ` (${source}:${event.lineNumber})` : "";
  return `window: ${String(event.message)}${where}`;
}
