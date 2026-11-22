import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filesFromArgv, Inbox, kindOf, OPEN_TAKE_CHANNEL, registerOpenIpc } from "../opened.js";

// REQ-000036-sJpO9KMY: files the OS hands the app, and the associations declared.

const here = path.dirname(fileURLToPath(import.meta.url));
const cwd = path.resolve("/work");

describe("REQ-000036-sJpO9KMY: files from a command line", () => {
  it("knows projects and captures by their extension", () => {
    expect(kindOf("/a/lab.correlator")).toBe("project");
    expect(kindOf("/a/run.RECORDING")).toBe("capture");
    expect(kindOf("/a/cpu.track")).toBe("capture");
    expect(kindOf("/a/old.cttc-record")).toBe("capture");
    expect(kindOf("/a/notes.txt")).toBeNull();
  });

  it("leaves out the executable, the app's folder unpackaged, and switches; resolves the rest", () => {
    expect(
      filesFromArgv(["/bin/electron", ".", "--inspect", "lab.correlator", "notes.txt"], cwd, true),
    ).toEqual({
      files: [path.resolve(cwd, "lab.correlator")],
      ignored: [path.resolve(cwd, "notes.txt")],
    });
    expect(filesFromArgv(["/Applications/correlate", "/d/run.recording"], cwd, false)).toEqual({
      files: [path.resolve("/d/run.recording")],
      ignored: [],
    });
  });
});

describe("REQ-000036-sJpO9KMY: the inbox", () => {
  it("keeps files until the window takes them, then sends the later ones", () => {
    const sent: unknown[] = [];
    const inbox = new Inbox((a) => sent.push(a));
    inbox.push({ files: ["/a.correlator"], ignored: [] });
    inbox.push({ files: ["/b.recording"], ignored: ["/c.txt"] });
    inbox.push({ files: [], ignored: [] });
    expect(sent).toEqual([]);
    expect(inbox.take()).toEqual({ files: ["/a.correlator", "/b.recording"], ignored: ["/c.txt"] });
    inbox.push({ files: ["/d.track"], ignored: [] });
    expect(sent).toEqual([{ files: ["/d.track"], ignored: [] }]);
    inbox.reset();
    inbox.push({ files: ["/e.track"], ignored: [] });
    expect(sent).toHaveLength(1);
    const handlers = new Map<string, () => unknown>();
    registerOpenIpc({ handle: (c, l) => void handlers.set(c, l as () => unknown) }, inbox);
    expect(handlers.get(OPEN_TAKE_CHANNEL)?.()).toEqual({ files: ["/e.track"], ignored: [] });
  });
});

describe("REQ-000036-sJpO9KMY: the associations", () => {
  it("are declared for the installers: projects, recordings and tracks, not cttc's", () => {
    const pkg = JSON.parse(readFileSync(path.join(here, "../../../package.json"), "utf8")) as {
      build: { fileAssociations: { ext: string; name: string; role: string }[] };
    };
    expect(pkg.build.fileAssociations.map((a) => [a.ext, a.name, a.role])).toEqual([
      ["correlator", "correlate project", "Editor"],
      ["recording", "correlate recording", "Editor"],
      ["track", "correlate track", "Editor"],
    ]);
  });
});
