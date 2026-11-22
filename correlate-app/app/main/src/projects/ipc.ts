/**
 * Projects for the renderer (REQ-000035-sJpO9KMY Requirements 2-5): each
 * window's project (`store.ts`), and its files shown through the analysis
 * view's open files (`../analysis/ipc.ts`, read when first shown).
 *
 * - `project:get`: the window's project, its missing files, and Recent.
 * - `project:new`, `project:open` (the open dialog), `project:openFile`
 *   (a Recent), `project:save` (Save As when it has no file yet),
 *   `project:saveAs` (the save dialog).
 * - `project:addFiles` (the open dialog for cttc's files): added to the
 *   project, read, the last shown.
 * - `project:show` (a file's id): read if not yet, and shown.
 * - `project:change` (an operation): new folder, rename, move, remove (a file
 *   closed too, falling back as br-ANLYS-000006-sJpO9KMY), a track's delay
 *   or visibility, bind and unbind.
 * - `project:tracks`: the shown file's tracks (delays and hidden ones).
 *
 * Every answer carries the project and the window's open list, so the
 * renderer draws both from one reply.
 */
import type { OpenFiles, OpenList } from "../analysis/ipc.js";
import { openFiles } from "../analysis/ipc.js";
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";
import {
  addFiles,
  addFolder,
  move,
  type Project,
  remove,
  renameFolder,
  renameProject,
  setTrack,
  type TrackSettings,
} from "./project.js";
import type { Projects, SessionView } from "./store.js";

export const PROJECT_GET_CHANNEL = "project:get";
export const PROJECT_NEW_CHANNEL = "project:new";
export const PROJECT_OPEN_CHANNEL = "project:open";
export const PROJECT_OPEN_FILE_CHANNEL = "project:openFile";
export const PROJECT_SAVE_CHANNEL = "project:save";
export const PROJECT_SAVE_AS_CHANNEL = "project:saveAs";
export const PROJECT_ADD_FILES_CHANNEL = "project:addFiles";
export const PROJECT_SHOW_CHANNEL = "project:show";
export const PROJECT_CHANGE_CHANNEL = "project:change";
export const PROJECT_TRACKS_CHANNEL = "project:tracks";

/** What the dialogs give. */
export interface ProjectDeps {
  /** The open dialog for a project: its path, or null. */
  askProject: (event: IpcEventLike) => Promise<string | null>;
  /** The save dialog for a project: its path, or null. */
  askSaveAs: (event: IpcEventLike, suggested: string) => Promise<string | null>;
  /** The open dialog for cttc's files: their paths, none when cancelled. */
  askFiles: (event: IpcEventLike) => Promise<string[]>;
  size?: (file: string) => Promise<number>;
  read?: (file: string) => Promise<Buffer>;
}

/** Every answer: the project and the window's open list, and what went wrong. */
export interface ProjectAnswer {
  ok: boolean;
  cancelled?: boolean;
  message?: string;
  /** Files refused, each with its reason. */
  refused?: string[];
  warnings?: string[];
  session: SessionView;
  open: OpenList;
  recent: string[];
}

/** A change to a project, as the renderer asks for it. */
export type ProjectChange =
  | { op: "addFolder"; name: string; parent?: string | null }
  | { op: "rename"; id: string; name: string }
  | { op: "renameProject"; name: string }
  | { op: "move"; id: string; folder: string | null }
  | { op: "remove"; id: string }
  | { op: "setTrack"; item: string; container: string; delaySecs?: number; hidden?: boolean }
  | { op: "bind"; sump: string; stream: string }
  | { op: "unbind" };

const windowOf = (event: IpcEventLike) => event?.sender?.id ?? -1;

/** Apply a change to a project; throws when it is not one this knows. */
export function applyChange(project: Project, change: ProjectChange): Project {
  switch (change.op) {
    case "addFolder":
      return addFolder(project, change.name, change.parent ?? null);
    case "rename":
      return renameFolder(project, change.id, change.name);
    case "renameProject":
      return renameProject(project, change.name);
    case "move":
      return move(project, change.id, change.folder);
    case "remove":
      return remove(project, change.id);
    case "setTrack":
      return setTrack(project, change.item, change.container, {
        delaySecs: change.delaySecs,
        hidden: change.hidden,
      });
    case "bind":
      return { ...project, sump: { id: change.sump, stream: change.stream } };
    case "unbind":
      return { ...project, sump: null };
    default:
      throw new Error("not a change of a project");
  }
}

/** The shown file's tracks: delays (s) and hidden containers, for the window. */
export function shownTracks(
  projects: Projects,
  files: OpenFiles,
  window: number,
): { item: string | null; tracks: Record<string, TrackSettings> } {
  const shown = files.list(window).active;
  const session = projects.session(window);
  const item = session.project.items.find((i) => i.path === shown);
  return { item: item?.id ?? null, tracks: item ? (session.project.tracks[item.id] ?? {}) : {} };
}

/** Answer the channels. */
export function registerProjectIpc(
  ipcMain: IpcMainLike,
  projects: Projects,
  files: OpenFiles,
  deps: ProjectDeps,
): void {
  const reply = (window: number, extra: Partial<ProjectAnswer> = {}): ProjectAnswer => ({
    ok: true,
    ...extra,
    session: projects.view(window),
    open: files.list(window),
    recent: projects.recent(),
  });
  const failed = (window: number, error: unknown) =>
    reply(window, { ok: false, message: (error as Error).message });
  /** Another project replaces the window's: its files are closed. */
  const replaced = (window: number) => files.close(window);
  /** Read and show `paths` (already in the project). */
  const show = async (event: IpcEventLike, paths: string[]) =>
    openFiles(event, files, { ask: async () => paths, size: deps.size, read: deps.read });

  ipcMain.handle(PROJECT_GET_CHANNEL, (event) => reply(windowOf(event)));
  ipcMain.handle(PROJECT_NEW_CHANNEL, (event) => {
    const window = windowOf(event);
    replaced(window);
    projects.newProject(window);
    return reply(window);
  });
  ipcMain.handle(PROJECT_OPEN_CHANNEL, async (event) => {
    const window = windowOf(event);
    const file = await deps.askProject(event);
    if (!file) return reply(window, { ok: false, cancelled: true });
    try {
      const before = projects.session(window).file;
      projects.open(window, file);
      if (before !== projects.session(window).file) replaced(window);
      return reply(window);
    } catch (error) {
      return failed(window, new Error(`Could not open ${file}: ${(error as Error).message}`));
    }
  });
  ipcMain.handle(PROJECT_OPEN_FILE_CHANNEL, (event, file) => {
    const window = windowOf(event);
    if (typeof file !== "string") return failed(window, new Error("not a project file"));
    try {
      projects.open(window, file);
      replaced(window);
      return reply(window);
    } catch (error) {
      return failed(window, new Error(`Could not open ${file}: ${(error as Error).message}`));
    }
  });
  const saveAs = async (event: IpcEventLike) => {
    const window = windowOf(event);
    const file = await deps.askSaveAs(event, `${projects.session(window).project.name}.correlator`);
    if (!file) return reply(window, { ok: false, cancelled: true });
    try {
      projects.saveAs(window, file);
      return reply(window);
    } catch (error) {
      return failed(window, error);
    }
  };
  ipcMain.handle(PROJECT_SAVE_CHANNEL, async (event) => {
    const window = windowOf(event);
    try {
      return projects.save(window) ? reply(window) : await saveAs(event);
    } catch (error) {
      return failed(window, error);
    }
  });
  ipcMain.handle(PROJECT_SAVE_AS_CHANNEL, (event) => saveAs(event));
  ipcMain.handle(PROJECT_ADD_FILES_CHANNEL, async (event) => {
    const window = windowOf(event);
    const chosen = await deps.askFiles(event);
    if (chosen.length === 0) return reply(window, { ok: false, cancelled: true });
    const opened = await show(event, chosen);
    // Only the files that could be read join the project.
    const good = chosen.filter((f) => files.has(window, f));
    if (good.length > 0) projects.change(window, (p) => addFiles(p, good));
    return reply(window, {
      ok: opened.ok,
      refused: opened.refused ?? [],
      warnings: opened.ok ? opened.warnings : [],
    });
  });
  ipcMain.handle(PROJECT_SHOW_CHANNEL, async (event, id) => {
    const window = windowOf(event);
    const item = projects.session(window).project.items.find((i) => i.id === id);
    if (!item) return failed(window, new Error("no such file in the project"));
    const opened = await show(event, [item.path]);
    return reply(window, { ok: opened.ok, refused: opened.refused ?? [] });
  });
  ipcMain.handle(PROJECT_CHANGE_CHANNEL, (event, change) => {
    const window = windowOf(event);
    try {
      const c = change as ProjectChange;
      if (c?.op === "remove") {
        const item = projects.session(window).project.items.find((i) => i.id === c.id);
        if (item) files.remove(window, item.path);
      }
      projects.change(window, (p) => applyChange(p, c));
      return reply(window);
    } catch (error) {
      return failed(window, error);
    }
  });
  ipcMain.handle(PROJECT_TRACKS_CHANNEL, (event) => shownTracks(projects, files, windowOf(event)));
}
