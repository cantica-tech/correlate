import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestHash, readCttcArchive } from "../archive.js";
import { convert, importCttc, importedName, importSummary } from "../cttcImport.js";
import { readZip } from "../zip.js";
import { zip } from "./zipWriter.js";

// br-ANLYS-000007 to -000009-sJpO9KMY (REQ-000055-sJpO9KMY): cttc's files
// imported as correlate-app's, beside them, the originals never changed.

const T0 = Date.UTC(2026, 7, 6, 12, 0, 0);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cttc-import-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A cttc archive: a container's stats, the host's, a container's logs; its hash as cttc writes it. */
function cttcArchive(hash: "right" | "wrong" | "none" = "right"): Buffer {
  const manifest: Record<string, unknown> = {
    version: 3,
    segments: [
      {
        from: T0,
        to: T0 + 60_000,
        created: "2026-08-06T12:00:00.000Z",
        sources: [
          { type: "stats", name: "stats@local", file: "seg0/stats/0.json", is_host: false },
          {
            type: "stats",
            name: "host@local",
            file: "seg0/stats/1.json",
            is_host: true,
            docker_host_id: "local",
          },
          { type: "log", name: "web", file: "seg0/logs/2.jsonl", count: 2 },
        ],
      },
    ],
  };
  const text = JSON.stringify(manifest);
  if (hash !== "none") {
    manifest.integrity_sha256 = hash === "right" ? manifestHash(text) : "0".repeat(64);
  }
  return zip({
    "seg0/stats/0.json": JSON.stringify({
      series: { web: [[T0 + 1000, 12.5, 40, 1000, 2000]], db: [[T0 + 2000, 3, 10, 500, 100]] },
    }),
    "seg0/stats/1.json": JSON.stringify({
      series: { "host@local": [[T0 + 1000, 26.4, 67.9, 1.1e10, 256981]] },
    }),
    "seg0/logs/2.jsonl": [
      { ts: T0 + 500, text: "GET / 200" },
      { ts: T0 + 900, text: "ERROR db timed out" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
    "manifest.json": JSON.stringify(manifest),
  });
}

/** What a file reads as, without its own name and path. */
function data(file: string) {
  const { label: _l, path: _p, warnings: _w, ...rest } = readCttcArchive(readFileSync(file), file);
  return rest;
}

describe("br-ANLYS-000007-sJpO9KMY: importing never changes a cttc file", () => {
  it("writes the matching file beside each original, which stays as it was", () => {
    const record = path.join(dir, "trip.cttc-record");
    const metric = path.join(dir, "cpu.cttc-metric");
    writeFileSync(record, cttcArchive());
    writeFileSync(metric, cttcArchive());
    const before = [readFileSync(record), readFileSync(metric)];
    const result = importCttc([record, metric]);
    expect(result.skipped).toEqual([]);
    expect(result.imported.map((i) => path.basename(i.to))).toEqual([
      "trip.recording",
      "cpu.track",
    ]);
    expect([readFileSync(record), readFileSync(metric)]).toEqual(before);
  });

  it("never overwrites: a taken name gets (2), then (3)", () => {
    const record = path.join(dir, "trip.cttc-record");
    writeFileSync(record, cttcArchive());
    writeFileSync(path.join(dir, "trip.recording"), "mine");
    importCttc([record]);
    importCttc([record]);
    expect(readFileSync(path.join(dir, "trip.recording"), "utf8")).toBe("mine");
    expect(readdirSync(dir).sort()).toEqual([
      "trip (2).recording",
      "trip (3).recording",
      "trip.cttc-record",
      "trip.recording",
    ]);
    expect(importedName(path.join(dir, "x.CTTC-METRIC"), () => false)).toBe(
      path.join(dir, "x.track"),
    );
  });

  it("imports the cttc files directly in a chosen folder, not its subfolders", () => {
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "a.cttc-record"), cttcArchive());
    writeFileSync(path.join(dir, "notes.txt"), "not cttc");
    writeFileSync(path.join(dir, "sub", "b.cttc-record"), cttcArchive());
    const empty = path.join(dir, "sub", "empty");
    mkdirSync(empty);
    const result = importCttc([dir, empty]);
    expect(result.imported.map((i) => path.basename(i.to))).toEqual(["a.recording"]);
    expect(result.skipped).toEqual([{ path: empty, reason: "no cttc files in it" }]);
  });
});

describe("br-ANLYS-000008-sJpO9KMY: an imported file holds exactly the original's data", () => {
  it("reads back to the original's data, its hash computed again", () => {
    const record = path.join(dir, "trip.cttc-record");
    writeFileSync(record, cttcArchive());
    const [done] = importCttc([record]).imported;
    expect(data(done.to)).toEqual(data(record));
    const manifest = readZip(readFileSync(done.to)).get("manifest.json")?.toString("utf8") ?? "";
    expect(JSON.parse(manifest).integrity_sha256).toBe(manifestHash(manifest));
    expect(readCttcArchive(readFileSync(done.to), done.to).warnings).toEqual([]);
    // Every entry but the manifest is the original's, byte for byte.
    const before = readZip(readFileSync(record));
    const after = readZip(readFileSync(done.to));
    for (const [name, bytes] of before)
      if (name !== "manifest.json") expect(after.get(name)).toEqual(bytes);
  });

  it("imports a file whose hash did not match, and says so; hashes one that had none", () => {
    const wrong = path.join(dir, "wrong.cttc-record");
    const none = path.join(dir, "none.cttc-record");
    writeFileSync(wrong, cttcArchive("wrong"));
    writeFileSync(none, cttcArchive("none"));
    const result = importCttc([wrong, none]);
    expect(result.imported.map((i) => i.warnings.length)).toEqual([1, 0]);
    expect(readCttcArchive(readFileSync(result.imported[0].to), "x").warnings).toEqual([]);
    expect(data(result.imported[1].to)).toEqual(data(none));
    expect(convert(cttcArchive("none")).length).toBeGreaterThan(0);
  });

  it("skips what cttc's reader refuses, and what is not a cttc file, with why", () => {
    const broken = path.join(dir, "broken.cttc-record");
    const other = path.join(dir, "trip.recording");
    writeFileSync(broken, "not a zip");
    writeFileSync(other, cttcArchive());
    const result = importCttc([broken, other]);
    expect(result.imported).toEqual([]);
    expect(result.skipped.map((s) => path.basename(s.path))).toEqual([
      "trip.recording",
      "broken.cttc-record",
    ]);
    expect(readdirSync(dir).sort()).toEqual(["broken.cttc-record", "trip.recording"]);
  });
});

describe("br-ANLYS-000009-sJpO9KMY: an import says what it did", () => {
  it("counts what was imported, names mismatches and what was skipped", () => {
    expect(
      importSummary({
        imported: [
          { from: "/a/trip.cttc-record", to: "/a/trip.recording", warnings: [] },
          { from: "/a/cpu.cttc-metric", to: "/a/cpu.track", warnings: ["mismatch"] },
        ],
        skipped: [{ path: "/a/broken.cttc-record", reason: "not a zip" }],
      }),
    ).toBe(
      "Imported 2 cttc files; cpu.cttc-metric: the original's integrity hash did not match; broken.cttc-record skipped: not a zip",
    );
    expect(importSummary({ imported: [], skipped: [] })).toBe("No cttc file imported");
  });
});
