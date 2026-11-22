import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenFiles } from "../../analysis/ipc.js";
import { zip } from "../../analysis/tests/zipWriter.js";
import { Settings } from "../../theme.js";
import {
  applyChange,
  PROJECT_ADD_FILES_CHANNEL,
  PROJECT_CHANGE_CHANNEL,
  PROJECT_GET_CHANNEL,
  PROJECT_NEW_CHANNEL,
  PROJECT_OPEN_CHANNEL,
  PROJECT_SAVE_AS_CHANNEL,
  PROJECT_SAVE_CHANNEL,
  PROJECT_SHOW_CHANNEL,
  PROJECT_TRACKS_CHANNEL,
  type ProjectAnswer,
  registerProjectIpc,
} from "../ipc.js";
import { emptyProject } from "../project.js";
import { Projects } from "../store.js";

// REQ-000035-sJpO9KMY Requirements 2-5: the window's project, its files and tracks.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "project-ipc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A cttc archive of one container's log. */
const archive = () =>
  zip({
    "manifest.json": JSON.stringify({
      version: 3,
      segments: [
        {
          from: 1_000_000,
          to: 2_000_000,
          sources: [{ type: "log", name: "web", file: "l.jsonl" }],
        },
      ],
    }),
    "l.jsonl": JSON.stringify({ ts: 1_500_000, text: "hello" }),
  });

function setup(
  answers: { files?: string[]; project?: string | null; saveAs?: string | null } = {},
) {
  const projects = new Projects(
    dir,
    new Settings(path.join(dir, "settings.json"), { warn: () => {} }),
  );
  const files = new OpenFiles();
  const handlers = new Map<string, (e: object, m?: unknown) => Promise<ProjectAnswer> | unknown>();
  registerProjectIpc({ handle: (c, l) => void handlers.set(c, l) }, projects, files, {
    askProject: async () => answers.project ?? null,
    askSaveAs: async () => answers.saveAs ?? null,
    askFiles: async () => answers.files ?? [],
    size: async () => 100,
    read: async (f) => (f.endsWith("bad.cttc-record") ? Buffer.from("no") : archive()),
  });
  const call = (channel: string, m?: unknown) =>
    handlers.get(channel)?.({ sender: { id: 1 } }, m) as Promise<ProjectAnswer>;
  return { projects, files, call };
}

describe("REQ-000035-sJpO9KMY: the window's project", () => {
  it("adds the files that can be read and shows the last", async () => {
    const a = path.join(dir, "a.cttc-record");
    const b = path.join(dir, "bad.cttc-record");
    const c = path.join(dir, "c.cttc-record");
    const { call } = setup({ files: [a, b, c] });
    const r = await call(PROJECT_ADD_FILES_CHANNEL);
    expect(r.session.project.items.map((i) => i.path)).toEqual([a, c]);
    expect(r.open.active).toBe(c);
    expect(r.refused).toEqual([expect.stringContaining("bad.cttc-record: not a zip")]);
    expect(r.session.isDefault).toBe(true);
  });

  it("shows a file by id, removes it (closed, the view falling back), and keeps tracks", async () => {
    const a = path.join(dir, "a.cttc-record");
    const c = path.join(dir, "c.cttc-record");
    const { call } = setup({ files: [a, c] });
    await call(PROJECT_ADD_FILES_CHANNEL);
    const shown = await call(PROJECT_SHOW_CHANNEL, "f1");
    expect(shown.open.active).toBe(a);
    const delayed = await call(PROJECT_CHANGE_CHANNEL, {
      op: "setTrack",
      item: "f1",
      container: "web",
      delaySecs: 2,
    });
    expect(delayed.session.project.tracks.f1?.web).toEqual({ delaySecs: 2, hidden: false });
    expect(await call(PROJECT_TRACKS_CHANNEL)).toEqual({
      item: "f1",
      tracks: { web: { delaySecs: 2, hidden: false } },
    });
    const removed = await call(PROJECT_CHANGE_CHANNEL, { op: "remove", id: "f1" });
    expect(removed.session.project.items.map((i) => i.id)).toEqual(["f2"]);
    expect(removed.open.active).toBe(c);
    expect((await call(PROJECT_SHOW_CHANNEL, "f9")).ok).toBe(false);
  });

  it("binds and unbinds a Sump; refuses an unknown change", async () => {
    const { call } = setup();
    const bound = await call(PROJECT_CHANGE_CHANNEL, { op: "bind", sump: "local", stream: "self" });
    expect(bound.session.project.sump).toEqual({ id: "local", stream: "self" });
    expect((await call(PROJECT_CHANGE_CHANNEL, { op: "unbind" })).session.project.sump).toBeNull();
    expect((await call(PROJECT_CHANGE_CHANNEL, { op: "explode" })).ok).toBe(false);
    expect(() => applyChange(emptyProject(), { op: "renameProject", name: "" })).toThrow();
  });

  it("saves a new project through Save As, then opens another, its files closed", async () => {
    const lab = path.join(dir, "lab.correlator");
    const { call, files } = setup({ saveAs: lab, files: [path.join(dir, "a.cttc-record")] });
    await call(PROJECT_NEW_CHANNEL);
    await call(PROJECT_ADD_FILES_CHANNEL);
    expect((await call(PROJECT_GET_CHANNEL)).session.dirty).toBe(true);
    const saved = await call(PROJECT_SAVE_CHANNEL);
    expect(saved.session).toMatchObject({ file: lab, dirty: false });
    expect(saved.recent).toEqual([lab]);
    const other = path.join(dir, "other.correlator");
    writeFileSync(other, JSON.stringify({ version: 1, name: "Other" }));
    const again = setup({ project: other, saveAs: null });
    const opened = await again.call(PROJECT_OPEN_CHANNEL);
    expect(opened.session).toMatchObject({ name: "Other", file: other });
    expect(files.list(1).files).toHaveLength(1);
    const savedAgain = await call(PROJECT_SAVE_AS_CHANNEL);
    expect(savedAgain.session).toMatchObject({ file: lab, dirty: false });
    const none = setup({ saveAs: null });
    expect(await none.call(PROJECT_SAVE_AS_CHANNEL)).toMatchObject({ ok: false, cancelled: true });
  });
});
