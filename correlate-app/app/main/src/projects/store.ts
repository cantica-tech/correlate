/**
 * Each window's open project (REQ-000035-sJpO9KMY Requirement 2): the
 * default project at `default.correlator` in the app's data folder (beside
 * the settings), created when missing and saved on every change; or another
 * project, marked unsaved when changed until saved. New, Open, Save, Save As
 * (from the default, the default stays as it was) and Recent (the last 10,
 * kept in the settings under `projects`). Writes go to a temporary file
 * renamed over the target, so a project is never left half written.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Settings } from "../theme.js";
import {
  emptyProject,
  PROJECT_EXTENSION,
  type Project,
  parseProject,
  writeProject,
} from "./project.js";

/** The default project's file name in the app's data folder. */
export const DEFAULT_PROJECT = `default.${PROJECT_EXTENSION}`;
/** How many recent projects are kept. */
export const RECENT_MAX = 10;
const PART = "projects";

/** A window's open project. */
export interface Session {
  /** Its file, or null for a new project not saved yet. */
  file: string | null;
  project: Project;
  /** Changed since it was opened or saved (never for the default, which saves itself). */
  dirty: boolean;
  isDefault: boolean;
}

/** What the renderer is told of a session. */
export interface SessionView {
  file: string | null;
  name: string;
  dirty: boolean;
  isDefault: boolean;
  project: Project;
  /** Files of the project not found on disk. */
  missing: string[];
}

/** Write `text` to `file` atomically: a temporary file beside it, renamed over it. */
export function writeAtomic(file: string, text: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, text, { mode: 0o644 });
  renameSync(temp, file);
}

/** Each window's open project. */
export class Projects {
  private readonly sessions = new Map<number, Session>();
  readonly defaultFile: string;

  constructor(
    dataDir: string,
    private readonly settings: Settings,
    private readonly exists: (file: string) => boolean = existsSync,
  ) {
    this.defaultFile = path.join(dataDir, DEFAULT_PROJECT);
  }

  /** The window's session, the default project to begin with. */
  session(window: number): Session {
    let session = this.sessions.get(window);
    if (!session) {
      session = this.loadDefault();
      this.sessions.set(window, session);
    }
    return session;
  }

  /** What the renderer sees of the window's session. */
  view(window: number): SessionView {
    const s = this.session(window);
    return {
      file: s.file,
      name: s.project.name,
      dirty: s.dirty,
      isDefault: s.isDefault,
      project: s.project,
      missing: s.project.items.filter((i) => !this.exists(i.path)).map((i) => i.path),
    };
  }

  /** The default project, created (and written) when missing; a damaged one is set aside. */
  private loadDefault(): Session {
    const file = this.defaultFile;
    if (existsSync(file)) {
      try {
        return {
          file,
          project: parseProject(readFileSync(file, "utf8"), file),
          dirty: false,
          isDefault: true,
        };
      } catch {
        // A damaged default is kept aside, never overwritten silently.
        renameSync(file, `${file}.damaged-${Date.now()}`);
      }
    }
    const project = emptyProject("Default");
    writeAtomic(file, writeProject(project, file));
    return { file, project, dirty: false, isDefault: true };
  }

  /** A new project, not saved yet, replacing the window's. */
  newProject(window: number, name = "Untitled"): SessionView {
    this.sessions.set(window, {
      file: null,
      project: emptyProject(name),
      dirty: true,
      isDefault: false,
    });
    return this.view(window);
  }

  /** Open a project file in the window; throws with the reason when it is not one. */
  open(window: number, file: string): SessionView {
    const abs = path.resolve(file);
    const isDefault = abs === path.resolve(this.defaultFile);
    const project = parseProject(readFileSync(abs, "utf8"), abs);
    this.sessions.set(window, { file: abs, project, dirty: false, isDefault });
    if (!isDefault) this.remember(abs);
    return this.view(window);
  }

  /** Save the window's project to its file; false when it has none (Save As then). */
  save(window: number): boolean {
    const s = this.session(window);
    if (!s.file) return false;
    writeAtomic(s.file, writeProject(s.project, s.file));
    s.dirty = false;
    if (!s.isDefault) this.remember(s.file);
    return true;
  }

  /** Save the window's project as `file`, which it becomes; the default stays as it was. */
  saveAs(window: number, file: string): SessionView {
    const s = this.session(window);
    const abs = path.resolve(file);
    if (abs === path.resolve(this.defaultFile))
      throw new Error("the default project is saved on its own");
    const project = {
      ...s.project,
      name: s.isDefault ? path.basename(abs, `.${PROJECT_EXTENSION}`) : s.project.name,
    };
    writeAtomic(abs, writeProject(project, abs));
    this.sessions.set(window, { file: abs, project, dirty: false, isDefault: false });
    this.remember(abs);
    return this.view(window);
  }

  /** Change the window's project: the default saves itself, another is marked unsaved. */
  change(window: number, update: (project: Project) => Project): SessionView {
    const s = this.session(window);
    s.project = update(s.project);
    if (s.isDefault && s.file) writeAtomic(s.file, writeProject(s.project, s.file));
    else s.dirty = true;
    return this.view(window);
  }

  /** Whether the window's project has changes not saved. */
  dirty(window: number): boolean {
    return this.sessions.get(window)?.dirty ?? false;
  }

  /** The recent projects, newest first, those still on disk. */
  recent(): string[] {
    const part = this.settings.part(PART) as { recent?: unknown } | undefined;
    const list = Array.isArray(part?.recent) ? part.recent : [];
    return list
      .filter((f): f is string => typeof f === "string" && this.exists(f))
      .slice(0, RECENT_MAX);
  }

  private remember(file: string): void {
    const part = (this.settings.part(PART) as Record<string, unknown> | undefined) ?? {};
    const before = Array.isArray(part.recent) ? (part.recent as unknown[]) : [];
    const recent = [file, ...before.filter((f) => f !== file && typeof f === "string")].slice(
      0,
      RECENT_MAX,
    );
    this.settings.setPart(PART, { ...part, recent });
  }

  /** The window closed. */
  close(window: number): void {
    this.sessions.delete(window);
  }
}
