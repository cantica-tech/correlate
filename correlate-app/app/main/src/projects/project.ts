/**
 * A project (`*.correlator`, REQ-000035-sJpO9KMY Requirement 1, decided in
 * FEAT-000036-sJpO9KMY), as correlator's design and VS Code's
 * `.code-workspace`: a JSON workspace referencing captures by path, never
 * copying them, grouped in virtual folders that do not depend on where the
 * files are; the Sump and data stream it is bound to; and each track's
 * delay and visibility (a track: one container's data in a file).
 *
 * Pure: parsing, writing and changing a project. A file's path is kept
 * relative to the project file when both are on the same disk (volume, on
 * Windows), absolute otherwise, so a project and its captures move together.
 * Unknown keys are kept as they were, so a newer app's project survives an
 * older one.
 */
import path from "node:path";

/** The format's version. */
export const PROJECT_VERSION = 1;
/** The extension of a project file. */
export const PROJECT_EXTENSION = "correlator";

/** A virtual folder. */
export interface Folder {
  id: string;
  name: string;
  /** The folder it is in, or null at the top. */
  parent: string | null;
}

/** A file of the project; `path` absolute in memory. */
export interface Item {
  id: string;
  path: string;
  /** The folder it is in, or null at the top. */
  folder: string | null;
}

/** A track's settings. */
export interface TrackSettings {
  /** Seconds its data is shifted by in the analysis view, signed. */
  delaySecs: number;
  /** Hidden in the legend, the strips and the panels. */
  hidden: boolean;
}

/** A project in memory. */
export interface Project {
  name: string;
  folders: Folder[];
  items: Item[];
  /** The Sump (catalog id) and data stream it is bound to, or null. */
  sump: { id: string; stream: string } | null;
  /** Per item id, per container. */
  tracks: Record<string, Record<string, TrackSettings>>;
  /** Keys this app does not know, kept as read. */
  extra: Record<string, unknown>;
}

/** A track's delay is at most a day either way. */
export const MAX_DELAY_SECS = 86_400;
/** A name is 1 to 200 characters, no control characters. */
function isName(value: string): boolean {
  return (
    value.length >= 1 && value.length <= 200 && ![...value].some((c) => c < " " || c === "\x7f")
  );
}

/** A new, empty project. */
export function emptyProject(name = "Untitled"): Project {
  return { name, folders: [], items: [], sump: null, tracks: {}, extra: {} };
}

/** Whether two absolute paths are on the same disk (the same volume, on Windows). */
function sameDisk(a: string, b: string, p: typeof path): boolean {
  return p.parse(a).root.toLowerCase() === p.parse(b).root.toLowerCase();
}

/** The path stored for `file` in a project at `projectFile`: relative on the same disk. */
export function storedPath(file: string, projectFile: string, p: typeof path = path): string {
  const dir = p.dirname(projectFile);
  if (!sameDisk(file, dir, p)) return file;
  return p.relative(dir, file).split(p.sep).join("/");
}

/** The absolute path of a stored one, for a project at `projectFile`. */
export function absolutePath(stored: string, projectFile: string, p: typeof path = path): string {
  if (p.isAbsolute(stored)) return p.normalize(stored);
  return p.resolve(p.dirname(projectFile), ...stored.split("/"));
}

/** A string, or throws `what`. */
function text(value: unknown, what: string): string {
  if (typeof value !== "string" || !isName(value)) throw new Error(`${what} is not a name`);
  return value;
}

/** Read a project's text; throws with the reason when it is not one. */
export function parseProject(textIn: string, projectFile: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(textIn);
  } catch {
    throw new Error("not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("not a project");
  const r = raw as Record<string, unknown>;
  if (r.version !== PROJECT_VERSION)
    throw new Error(`version ${String(r.version)} is not read (1 is)`);
  const { version: _v, name, folders, items, sump, tracks, ...extra } = r;
  const project = emptyProject(text(name, "the project's name"));
  project.extra = extra;
  for (const f of Array.isArray(folders) ? folders : []) {
    const folder = f as Record<string, unknown>;
    project.folders.push({
      id: text(folder.id, "a folder's id"),
      name: text(folder.name, "a folder's name"),
      parent: folder.parent == null ? null : text(folder.parent, "a folder's parent"),
    });
  }
  for (const i of Array.isArray(items) ? items : []) {
    const item = i as Record<string, unknown>;
    project.items.push({
      id: text(item.id, "a file's id"),
      path: absolutePath(text(item.path, "a file's path"), projectFile),
      folder: item.folder == null ? null : text(item.folder, "a file's folder"),
    });
  }
  if (sump && typeof sump === "object") {
    const s = sump as Record<string, unknown>;
    project.sump = { id: text(s.id, "the Sump"), stream: text(s.stream, "the data stream") };
  }
  if (tracks && typeof tracks === "object" && !Array.isArray(tracks)) {
    for (const [item, byContainer] of Object.entries(tracks as Record<string, unknown>)) {
      if (!byContainer || typeof byContainer !== "object") continue;
      for (const [container, t] of Object.entries(byContainer as Record<string, unknown>)) {
        const track = (t ?? {}) as Record<string, unknown>;
        project.tracks[item] ??= {};
        (project.tracks[item] as Record<string, TrackSettings>)[container] = {
          delaySecs: clampDelay(Number(track.delaySecs ?? 0)),
          hidden: track.hidden === true,
        };
      }
    }
  }
  // A folder or file in a folder that does not exist goes to the top.
  const ids = new Set(project.folders.map((f) => f.id));
  for (const f of project.folders) if (f.parent && !ids.has(f.parent)) f.parent = null;
  for (const i of project.items) if (i.folder && !ids.has(i.folder)) i.folder = null;
  return project;
}

/** A project's text, its paths stored for `projectFile`. */
export function writeProject(project: Project, projectFile: string): string {
  return `${JSON.stringify(
    {
      ...project.extra,
      version: PROJECT_VERSION,
      name: project.name,
      folders: project.folders,
      items: project.items.map((i) => ({ ...i, path: storedPath(i.path, projectFile) })),
      sump: project.sump,
      tracks: project.tracks,
    },
    null,
    2,
  )}\n`;
}

/** A delay in range: a finite number of seconds, at most a day either way. */
export function clampDelay(secs: number): number {
  if (!Number.isFinite(secs)) return 0;
  return Math.max(-MAX_DELAY_SECS, Math.min(MAX_DELAY_SECS, secs));
}

/** A new id not used in `project`. */
export function newId(project: Project, prefix: string): string {
  const used = new Set([...project.folders.map((f) => f.id), ...project.items.map((i) => i.id)]);
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** `project` with `files` added at the top (those already in it left as they are). */
export function addFiles(
  project: Project,
  files: readonly string[],
  folder: string | null = null,
): Project {
  const next = { ...project, items: [...project.items] };
  for (const file of files) {
    const abs = path.resolve(file);
    if (next.items.some((i) => i.path === abs)) continue;
    next.items.push({ id: newId(next, "f"), path: abs, folder });
  }
  return next;
}

/** `project` with a new folder named `name` in `parent`. */
export function addFolder(project: Project, name: string, parent: string | null = null): Project {
  const folder = { id: newId(project, "d"), name: text(name, "a folder's name"), parent };
  return { ...project, folders: [...project.folders, folder] };
}

/** `project` renamed. */
export function renameProject(project: Project, name: string): Project {
  return { ...project, name: text(name, "the project's name") };
}

/** `project` with folder `id` renamed. */
export function renameFolder(project: Project, id: string, name: string): Project {
  const checked = text(name, "a folder's name");
  return {
    ...project,
    folders: project.folders.map((f) => (f.id === id ? { ...f, name: checked } : f)),
  };
}

/** Whether folder `id` is `ancestor` or inside it. */
function within(project: Project, id: string | null, ancestor: string): boolean {
  for (let at = id; at; at = project.folders.find((f) => f.id === at)?.parent ?? null) {
    if (at === ancestor) return true;
  }
  return false;
}

/** `project` with a file or folder moved into `folder` (null: the top); a folder never into itself. */
export function move(project: Project, id: string, folder: string | null): Project {
  if (folder !== null && !project.folders.some((f) => f.id === folder)) return project;
  if (project.items.some((i) => i.id === id)) {
    return { ...project, items: project.items.map((i) => (i.id === id ? { ...i, folder } : i)) };
  }
  if (folder !== null && within(project, folder, id)) return project;
  return {
    ...project,
    folders: project.folders.map((f) => (f.id === id ? { ...f, parent: folder } : f)),
  };
}

/** `project` without file `id` (its tracks forgotten), or without folder `id` (its contents moved up). */
export function remove(project: Project, id: string): Project {
  const item = project.items.find((i) => i.id === id);
  if (item) {
    const { [id]: _gone, ...tracks } = project.tracks;
    return { ...project, items: project.items.filter((i) => i.id !== id), tracks };
  }
  const folder = project.folders.find((f) => f.id === id);
  if (!folder) return project;
  return {
    ...project,
    folders: project.folders
      .filter((f) => f.id !== id)
      .map((f) => (f.parent === id ? { ...f, parent: folder.parent } : f)),
    items: project.items.map((i) => (i.folder === id ? { ...i, folder: folder.parent } : i)),
  };
}

/** `project` with a track's settings changed. */
export function setTrack(
  project: Project,
  item: string,
  container: string,
  change: Partial<TrackSettings>,
): Project {
  const current = project.tracks[item]?.[container] ?? { delaySecs: 0, hidden: false };
  const next: TrackSettings = {
    delaySecs: change.delaySecs === undefined ? current.delaySecs : clampDelay(change.delaySecs),
    hidden: change.hidden === undefined ? current.hidden : change.hidden,
  };
  return {
    ...project,
    tracks: { ...project.tracks, [item]: { ...(project.tracks[item] ?? {}), [container]: next } },
  };
}
