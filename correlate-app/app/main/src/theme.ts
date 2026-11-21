/**
 * The theme choice (REQ-000018-sJpO9KMY Requirement 3): system (the
 * default), light or dark. The main process applies it with Electron's
 * `nativeTheme.themeSource`, which drives every window's
 * `prefers-color-scheme` and the native menus and dialogs, as cttc's
 * `set-theme-mode` did; it does so before the first window opens, so no
 * window paints in the wrong theme (decided in FEAT-000019-sJpO9KMY).
 *
 * The choice is remembered in `~/.correlate/settings.json`
 * (`CORRELATE_SETTINGS` overrides the path), written atomically. An unreadable
 * file means `system`, and is logged. Preferences (Phase 11) will call
 * `theme.set()`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { IpcMainLike } from "./sump/ipc.js";
import { ensurePrivateDir, writeSecretFile } from "./vault/secure.js";

/** The theme choices. */
export type ThemeMode = "system" | "light" | "dark";

export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

/** The IPC channels of the theme. */
export const THEME_GET_CHANNEL = "theme:get";
export const THEME_SET_CHANNEL = "theme:set";

/** Where the settings live unless told otherwise. */
export function defaultSettingsPath(env: Record<string, string | undefined> = process.env): string {
  return env.CORRELATE_SETTINGS || path.join(homedir(), ".correlate", "settings.json");
}

/**
 * The app's own settings file: the theme and, kept beside it, other parts of
 * the app's state (the sidebar's layout, REQ-000021-sJpO9KMY), each under its
 * own key. Writing one part keeps the others.
 */
export class Settings {
  private mode: ThemeMode = "system";
  private readonly parts: Record<string, unknown> = {};

  constructor(
    readonly file: string,
    private readonly logger: { warn(message: string): void } = console,
  ) {
    if (!existsSync(file)) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
        throw new Error("not an object");
      }
      const { themeMode, ...parts } = saved;
      Object.assign(this.parts, parts);
      if (THEME_MODES.includes(themeMode as ThemeMode)) this.mode = themeMode as ThemeMode;
      else if (themeMode !== undefined) {
        this.logger.warn(`settings: unknown theme ${JSON.stringify(themeMode)}; using system`);
      }
    } catch (error) {
      this.logger.warn(
        `settings: ${file} is unreadable (${(error as Error).message}); using system`,
      );
    }
  }

  /** The theme choice. */
  themeMode(): ThemeMode {
    return this.mode;
  }

  /** Remember a theme choice; anything else than the three is refused. */
  setThemeMode(mode: unknown): ThemeMode {
    if (!THEME_MODES.includes(mode as ThemeMode)) {
      throw new Error(`the theme is one of ${THEME_MODES.join(", ")}`);
    }
    this.mode = mode as ThemeMode;
    this.save();
    return this.mode;
  }

  /** The part saved under `key`, as read from the file: callers check it. */
  part(key: string): unknown {
    return this.parts[key];
  }

  /** Remember `value` under `key`, keeping the theme and the other parts. */
  setPart(key: string, value: unknown): void {
    if (key === "themeMode") throw new Error("the theme is set with setThemeMode");
    this.parts[key] = value;
    this.save();
  }

  private save(): void {
    ensurePrivateDir(path.dirname(this.file));
    writeSecretFile(
      this.file,
      `${JSON.stringify({ themeMode: this.mode, ...this.parts }, null, 2)}\n`,
    );
  }
}

/**
 * Answer `theme:get` and `theme:set` on the bridge; `apply` sets
 * `nativeTheme.themeSource`. A refused value answers `{ ok: false }`.
 */
export function registerThemeIpc(
  ipcMain: IpcMainLike,
  settings: Settings,
  apply: (mode: ThemeMode) => void,
): void {
  ipcMain.handle(THEME_GET_CHANNEL, () => settings.themeMode());
  ipcMain.handle(THEME_SET_CHANNEL, (_event, mode) => {
    try {
      const chosen = settings.setThemeMode(mode);
      apply(chosen);
      return { ok: true, mode: chosen };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  });
}
