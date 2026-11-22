import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Settings } from "../../theme.js";
import {
  absolutePath,
  addFiles,
  addFolder,
  emptyProject,
  move,
  parseProject,
  remove,
  renameFolder,
  setTrack,
  storedPath,
  writeProject,
} from "../project.js";
import { DEFAULT_PROJECT, Projects, RECENT_MAX } from "../store.js";

// REQ-000035-sJpO9KMY Requirements 1 and 2: the project file, and each window's project.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "projects-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { warn: () => {} };
const settings = () => new Settings(path.join(dir, "settings.json"), quiet);

describe("REQ-000035-sJpO9KMY: paths in a project", () => {
  it("are relative to the project on the same disk, absolute otherwise", () => {
    const p = path.posix;
    expect(storedPath("/data/runs/a.cttc-record", "/data/p.correlator", p)).toBe(
      "runs/a.cttc-record",
    );
    expect(storedPath("/other/b.cttc-record", "/data/p.correlator", p)).toBe(
      "../other/b.cttc-record",
    );
    expect(absolutePath("runs/a.cttc-record", "/data/p.correlator", p)).toBe(
      "/data/runs/a.cttc-record",
    );
    const w = path.win32;
    expect(storedPath("D:\\runs\\a.cttc-record", "C:\\data\\p.correlator", w)).toBe(
      "D:\\runs\\a.cttc-record",
    );
    expect(storedPath("C:\\data\\runs\\a.cttc-record", "C:\\data\\p.correlator", w)).toBe(
      "runs/a.cttc-record",
    );
    expect(absolutePath("runs/a.cttc-record", "C:\\data\\p.correlator", w)).toBe(
      "C:\\data\\runs\\a.cttc-record",
    );
  });
});

describe("REQ-000035-sJpO9KMY: the project file", () => {
  const file = () => path.join(dir, "p.correlator");

  it("round-trips folders, files, the Sump and tracks, unknown keys kept", () => {
    let project = addFolder(emptyProject("Lab"), "Monday");
    const folder = project.folders[0]?.id ?? null;
    project = addFiles(project, [path.join(dir, "runs", "a.cttc-record")], folder);
    project = setTrack(project, project.items[0]?.id ?? "", "web", {
      delaySecs: -2.5,
      hidden: true,
    });
    project = { ...project, sump: { id: "local", stream: "self" }, extra: { future: [1, 2] } };
    const text = writeProject(project, file());
    expect(JSON.parse(text).items[0].path).toBe("runs/a.cttc-record");
    expect(JSON.parse(text).future).toEqual([1, 2]);
    expect(parseProject(text, file())).toEqual(project);
  });

  it.each([
    ["not JSON", "{", "not JSON"],
    ["an array", "[]", "not a project"],
    ["another version", '{"version": 2, "name": "x"}', "version 2"],
    ["no name", '{"version": 1}', "the project's name is not a name"],
    ["a bad path", '{"version": 1, "name": "x", "items": [{"id": "f1", "path": 7}]}', "path"],
  ])("refuses %s", (_what, text, why) => {
    expect(() => parseProject(text, file())).toThrow(why);
  });

  it("moves an entry in a lost folder to the top; clamps a delay", () => {
    const text = JSON.stringify({
      version: 1,
      name: "x",
      items: [{ id: "f1", path: "/a.cttc-record", folder: "gone" }],
      tracks: { f1: { web: { delaySecs: 1e9 } } },
    });
    const p = parseProject(text, file());
    expect(p.items[0]?.folder).toBeNull();
    expect(p.tracks.f1?.web).toEqual({ delaySecs: 86_400, hidden: false });
  });
});

describe("REQ-000035-sJpO9KMY: changing a project", () => {
  it("adds files once, makes folders, moves, renames and removes", () => {
    let p = addFiles(emptyProject(), ["/x/a.cttc-record", "/x/b.cttc-record", "/x/a.cttc-record"]);
    expect(p.items.map((i) => i.id)).toEqual(["f1", "f2"]);
    p = addFolder(p, "Runs");
    expect(p.folders.map((f) => f.id)).toEqual(["d1"]);
    p = addFolder(p, "Inner", "d1");
    p = move(p, "f1", "d2");
    p = move(p, "d1", "d2"); // never into itself
    expect(p.folders.find((f) => f.id === "d1")?.parent).toBeNull();
    p = renameFolder(p, "d2", "Deep");
    expect(p.folders.find((f) => f.id === "d2")?.name).toBe("Deep");
    p = setTrack(p, "f1", "web", { delaySecs: 3 });
    p = remove(p, "d2"); // its contents move up
    expect(p.items.find((i) => i.id === "f1")?.folder).toBe("d1");
    p = remove(p, "f1");
    expect(p.items.map((i) => i.id)).toEqual(["f2"]);
    expect(p.tracks.f1).toBeUndefined();
  });
});

describe("REQ-000035-sJpO9KMY: each window's project", () => {
  it("starts on the default, created and saved on every change", () => {
    const projects = new Projects(dir, settings());
    const view = projects.view(1);
    expect(view).toMatchObject({ isDefault: true, name: "Default", dirty: false });
    expect(existsSync(path.join(dir, DEFAULT_PROJECT))).toBe(true);
    projects.change(1, (p) => addFolder(p, "Runs"));
    expect(projects.dirty(1)).toBe(false);
    expect(readFileSync(path.join(dir, DEFAULT_PROJECT), "utf8")).toContain('"Runs"');
    // No temporary file is left behind.
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("sets a damaged default aside instead of overwriting it", () => {
    writeFileSync(path.join(dir, DEFAULT_PROJECT), "{ damaged");
    const projects = new Projects(dir, settings());
    expect(projects.view(1).isDefault).toBe(true);
    expect(readdirSync(dir).some((f) => f.startsWith(`${DEFAULT_PROJECT}.damaged-`))).toBe(true);
  });

  it("marks another project unsaved until saved; Save As from the default leaves it", () => {
    const projects = new Projects(dir, settings());
    projects.change(1, (p) => addFolder(p, "Kept"));
    const lab = path.join(dir, "lab.correlator");
    const saved = projects.saveAs(1, lab);
    expect(saved).toMatchObject({ file: lab, name: "lab", isDefault: false, dirty: false });
    expect(readFileSync(path.join(dir, DEFAULT_PROJECT), "utf8")).toContain('"Kept"');
    projects.change(1, (p) => addFolder(p, "New"));
    expect(projects.dirty(1)).toBe(true);
    expect(projects.save(1)).toBe(true);
    expect(projects.dirty(1)).toBe(false);
    expect(() => projects.saveAs(1, path.join(dir, DEFAULT_PROJECT))).toThrow("saved on its own");
  });

  it("opens a project, refuses one that is not, and keeps the last ten as Recent", () => {
    const projects = new Projects(dir, settings());
    const files = Array.from({ length: RECENT_MAX + 2 }, (_, n) =>
      path.join(dir, `p${n}.correlator`),
    );
    for (const f of files) writeFileSync(f, writeProject(emptyProject(path.basename(f)), f));
    for (const f of files) projects.open(1, f);
    expect(projects.recent()).toEqual([...files].reverse().slice(0, RECENT_MAX));
    writeFileSync(path.join(dir, "bad.correlator"), "nope");
    expect(() => projects.open(1, path.join(dir, "bad.correlator"))).toThrow("not JSON");
    const fresh = projects.newProject(1);
    expect(fresh).toMatchObject({ file: null, dirty: true, name: "Untitled" });
    expect(projects.save(1)).toBe(false);
  });

  it("lists a file not on disk as missing, and keeps it", () => {
    const projects = new Projects(dir, settings());
    const view = projects.change(1, (p) => addFiles(p, [path.join(dir, "gone.cttc-record")]));
    expect(view.missing).toEqual([path.join(dir, "gone.cttc-record")]);
    expect(view.project.items).toHaveLength(1);
  });
});
