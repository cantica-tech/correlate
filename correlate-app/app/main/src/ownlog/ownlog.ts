/**
 * The app's own log (br-DIAG-000001-sJpO9KMY, cttc's log collector,
 * `main.js` `startLogCollector`; REQ-000048-sJpO9KMY Requirement 1).
 *
 * On a never-configured install it is on, writing next to the app: one file
 * per start, `correlate-<ISO time>.log`, each line `<ISO time> <LEVEL> <text>`.
 * A write that fails falls back once to the app's data folder; one that fails
 * there too turns the log off, and says so. The 20 latest files are kept
 * (decided in FEAT-000050-sJpO9KMY); older ones are removed at start.
 * Its settings (`ownLog`: on, folder) live with the app's settings; the
 * Preferences controls come with Item 52.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

/** How many starts' files are kept. */
export const KEEP_FILES = 20;
/** A file of the own log. */
export const LOG_FILE = /^correlate-.+\.log$/;

/** The own log's settings, as kept. */
export interface OwnLogSettings {
  enabled: boolean;
  dir: string | null;
}

/** A line's level. */
export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** What the own log needs. */
export interface OwnLogDeps {
  /** The kept settings, or undefined on a never-configured install. */
  read: () => OwnLogSettings | undefined;
  write: (settings: OwnLogSettings) => void;
  /** Next to the app: where it writes by default. */
  defaultDir: string;
  /** The app's data folder: the one fallback. */
  fallbackDir: string;
  /** Said when the log falls back or turns off (the console, before the log). */
  warn: (text: string) => void;
  now?: () => Date;
  /** The disk; Node's by default. */
  append?: (file: string, text: string) => void;
  mkdir?: (dir: string) => void;
  list?: (dir: string) => string[];
  remove?: (file: string) => void;
}

/**
 * "Next to the app" for a packaged app: the folder holding the executable,
 * or on macOS the folder holding `correlate-app.app`, never inside the
 * bundle, whose signature a written file would break (REQ-000054-sJpO9KMY).
 */
export function besideTheApp(execPath: string, platform: NodeJS.Platform): string {
  const dir = path.dirname(execPath);
  const bundle = path.resolve(dir, "..", "..");
  if (platform === "darwin" && bundle.endsWith(".app")) return path.dirname(bundle);
  return dir;
}

/** The kept settings, or undefined when never configured (or unreadable). */
export function parseOwnLogSettings(value: unknown): OwnLogSettings | undefined {
  const v = value as Partial<OwnLogSettings> | null | undefined;
  if (!v || typeof v.enabled !== "boolean") return undefined;
  return { enabled: v.enabled, dir: typeof v.dir === "string" && v.dir ? v.dir : null };
}

/** A start's file name: `correlate-2026-11-22T19-06-40-123Z.log`. */
export function logFileName(now: Date): string {
  return `correlate-${now.toISOString().replace(/[:.]/g, "-")}.log`;
}

/** The own log of this run. */
export class OwnLog {
  private file: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: OwnLogDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The settings as they stand (never-configured: on, next to the app). */
  settings(): OwnLogSettings {
    return this.deps.read() ?? { enabled: true, dir: this.deps.defaultDir };
  }

  /** Where this run writes, or null when off. */
  current(): string | null {
    return this.file;
  }

  /** Start this run's file, if on; a never-configured install keeps "on, next to the app". */
  start(): void {
    const settings = this.settings();
    if (this.deps.read() === undefined) this.deps.write(settings);
    if (!settings.enabled) return;
    this.open(settings.dir ?? this.deps.defaultDir);
  }

  /** Turn the log on in `dir` (a new file), or off. */
  set(settings: OwnLogSettings): void {
    this.deps.write(settings);
    this.file = null;
    if (settings.enabled) this.open(settings.dir ?? this.deps.defaultDir);
  }

  private open(dir: string): void {
    this.file = path.join(dir, logFileName(this.now()));
    try {
      (this.deps.mkdir ?? ((d) => mkdirSync(d, { recursive: true })))(dir);
      this.prune(dir);
      this.append(`${this.now().toISOString()} INFO correlate-app's own log starts\n`);
    } catch (error) {
      this.failed(dir, error);
    }
  }

  /** Keep the latest `KEEP_FILES` - 1 others, so with this one there are `KEEP_FILES`. */
  private prune(dir: string): void {
    const list = this.deps.list ?? ((d: string) => readdirSync(d));
    const remove = this.deps.remove ?? ((f: string) => rmSync(f, { force: true }));
    const files = list(dir)
      .filter((f) => LOG_FILE.test(f))
      .sort()
      .reverse();
    for (const old of files.slice(KEEP_FILES - 1)) remove(path.join(dir, old));
  }

  private append(text: string): void {
    if (!this.file) return;
    (this.deps.append ?? ((f, t) => appendFileSync(f, t)))(this.file, text);
  }

  /** Write one line; a failure falls back once, then turns the log off. */
  write(level: Level, text: string): void {
    if (!this.file) return;
    const line = `${this.now().toISOString()} ${level} ${text.replace(/\r?\n/g, "\n    ")}\n`;
    try {
      this.append(line);
    } catch (error) {
      this.failed(path.dirname(this.file), error);
      try {
        this.append(line);
      } catch {
        // Already said; the log is off or its fallback failed too.
      }
    }
  }

  /** `dir` could not be written: its fallback once, then off. */
  private failed(dir: string, error: unknown): void {
    const why = (error as Error).message;
    this.file = null;
    const settings = this.settings();
    if (dir !== this.deps.fallbackDir) {
      this.deps.warn(
        `[own log] couldn't write to ${dir} (${why}) -- falling back to ${this.deps.fallbackDir}`,
      );
      this.deps.write({ ...settings, enabled: true, dir: this.deps.fallbackDir });
      this.open(this.deps.fallbackDir);
    } else {
      this.deps.warn(`[own log] couldn't write to ${dir} (${why}) -- turning the own log off`);
      this.deps.write({ ...settings, enabled: false });
    }
  }
}
