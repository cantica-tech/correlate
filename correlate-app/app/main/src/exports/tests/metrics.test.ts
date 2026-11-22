import { describe, expect, it } from "vitest";
import { readCttcArchive } from "../../analysis/archive.js";
import { appendToRecording } from "../../recording/archive.js";
import {
  buildExport,
  exportMetrics,
  exportName,
  exportToText,
  type MetricsDeps,
  type MetricsScope,
  parseMetrics,
  summarize,
} from "../metrics.js";

// REQ-000042-sJpO9KMY Requirement 2, br-EXPORT-000005-sJpO9KMY: the shown file's export.

const T0 = Date.UTC(2026, 10, 22, 12, 0);
const NOW = new Date(Date.UTC(2026, 10, 22, 15, 0, 0));

/** A file of web's and db's stats (cpu 1, 2, 3), the host's, and web's logs, over 3 s. */
const file = readCttcArchive(
  appendToRecording(
    null,
    {
      from: T0,
      to: T0 + 3000,
      sources: [
        {
          type: "stats",
          name: "stats@self",
          is_host: false,
          series: {
            web: [
              [T0, 1, 10, 100, null],
              [T0 + 1000, 3, 20, 200, 2500],
              [T0 + 2000, 2, 30, 300, 1500],
            ],
            db: [[T0, 50, 50, 50, 50]],
          },
        },
        { type: "stats", name: "host@local", is_host: true, series: { local: [[T0, 9, 9, 9, 9]] } },
        { type: "log", name: "web", rows: [{ ts: T0 + 500, text: "started\nmore" }] },
      ],
    },
    "new",
  ),
  "/in/a.recording",
);

const scope = (over: Partial<MetricsScope> = {}): MetricsScope => ({
  file,
  containers: ["web"],
  host: false,
  delays: {},
  ...over,
});

const all = { stats: true, logs: true, format: "text" as const, detail: "summary" as const };

describe("br-EXPORT-000005-sJpO9KMY: what the export holds", () => {
  it("summarizes each shown container: first, last, min, max, mean and the count", () => {
    const data = buildExport(scope(), all, NOW);
    expect(data.stats?.services).toEqual([
      {
        name: "web",
        host: false,
        count: 3,
        summary: {
          cpu: { first: 1, last: 2, min: 1, max: 3, mean: 2 },
          mem: { first: 10, last: 30, min: 10, max: 30, mean: 20 },
          mem_bytes: { first: 100, last: 300, min: 100, max: 300, mean: 200 },
          net: { first: 2500, last: 1500, min: 1500, max: 2500, mean: 2000 },
        },
      },
    ]);
    expect(data.logs).toEqual([{ source: "web", rows: [{ ts: T0 + 500, text: "started\nmore" }] }]);
    expect([data.from, data.to, data.generated_at]).toEqual([T0, T0 + 3000, NOW.toISOString()]);
  });

  it("holds only what the view shows: hidden containers out, the host only when shown", () => {
    expect(buildExport(scope(), all).stats?.services.map((s) => s.name)).toEqual(["web"]);
    const withHost = buildExport(scope({ host: true }), all);
    expect(withHost.stats?.services.map((s) => [s.name, s.host])).toEqual([
      ["localhost", true],
      ["web", false],
    ]);
  });

  it("gives every row in full, and leaves out what was not asked", () => {
    const data = buildExport(scope(), { ...all, logs: false, detail: "full" });
    expect(data.logs).toBeUndefined();
    expect(data.stats?.services[0].samples?.[1]).toEqual({
      ts: T0 + 1000,
      cpu: 3,
      mem: 20,
      mem_bytes: 200,
      net: 2500,
    });
  });

  it("applies each track's delay, and says it", () => {
    const data = buildExport(scope({ delays: { web: 2, db: 5 } }), { ...all, detail: "full" });
    expect(data.delays).toEqual({ web: 2 });
    expect(data.stats?.services[0]).toMatchObject({ delay: 2 });
    expect(data.stats?.services[0].samples?.[0].ts).toBe(T0 + 2000);
    expect(data.logs?.[0].rows[0].ts).toBe(T0 + 2500);
    expect(exportToText(data)).toContain("Delays applied: web +2s");
  });

  it("ignores missing values in a summary", () => {
    expect(summarize([{ ts: 0, cpu: null, mem: 1, mem_bytes: null, net: null }])).toEqual({
      mem: { first: 1, last: 1, min: 1, max: 1, mean: 1 },
    });
  });
});

describe("cttc's export text, with UTC times", () => {
  it("writes the header, the fields explained, the summary and the logs", () => {
    const lines = exportToText(buildExport(scope(), all, NOW)).split("\n");
    expect(lines.slice(0, 2)).toEqual([
      "Metrics export @ 2026-11-22T15:00:00.000Z",
      "Range: 2026-11-22 12:00:00.000 UTC — 2026-11-22 12:00:03.000 UTC",
    ]);
    expect(lines).toContain("== Stats (summary) ==");
    expect(lines).toContain("mem_bytes: memory in use, in bytes");
    expect(lines).toContain(
      "  cpu: first 1.0%  last 2.0%  min 1.0%  max 3.0%  mean 2.0%  (3 samples)",
    );
    expect(lines).toContain(
      "  net: first 2.5 kB/s  last 1.5 kB/s  min 1.5 kB/s  max 2.5 kB/s  mean 2.0 kB/s  (3 samples)",
    );
    expect(lines.slice(-4)).toEqual([
      "== Logs ==",
      "",
      "[web]",
      "  2026-11-22 12:00:00.500 UTC  started",
    ]);
  });

  it("writes every row with its full time", () => {
    const text = exportToText(buildExport(scope(), { ...all, logs: false, detail: "full" }, NOW));
    expect(text).toContain("== Stats (full time series) ==");
    expect(text).toContain("  2026-11-22 12:00:00.000 UTC  cpu=1  mem=10  mem_bytes=100  net=-");
  });

  it("names the export after when it is made", () => {
    expect(exportName(NOW, "text")).toBe("metrics-export-2026-11-22-15-00-00.txt");
    expect(exportName(NOW, "json")).toBe("metrics-export-2026-11-22-15-00-00.json");
  });
});

describe("br-EXPORT-000002-sJpO9KMY: the export's destination first", () => {
  const deps = (
    answer: string | null,
    written: Map<string, string>,
    shown = true,
  ): MetricsDeps => ({
    scope: () => (shown ? scope() : undefined),
    askSave: async () => answer,
    write: async (f, c) => void written.set(f, c),
    now: () => NOW,
  });

  it("writes text or JSON where the user chose", async () => {
    const written = new Map<string, string>();
    expect(await exportMetrics({ ...all, format: "json" }, deps("/out/m.json", written))).toEqual({
      ok: true,
      file: "/out/m.json",
    });
    expect(JSON.parse(written.get("/out/m.json") as string)).toMatchObject({
      from: T0,
      to: T0 + 3000,
    });
  });

  it("writes nothing when cancelled, and refuses in the live view", async () => {
    const written = new Map<string, string>();
    expect(await exportMetrics(all, deps(null, written))).toEqual({ ok: false, cancelled: true });
    expect(await exportMetrics(all, deps("/x", written, false))).toEqual({
      ok: false,
      message: "Export Metrics needs a file shown in the analysis view",
    });
    expect(written.size).toBe(0);
  });

  it("refuses an export of nothing", () => {
    expect(() => parseMetrics({ stats: false, logs: false })).toThrow(/nothing to export/);
    expect(parseMetrics({ stats: true, format: "json", detail: "full" })).toEqual({
      stats: true,
      logs: false,
      format: "json",
      detail: "full",
    });
  });
});
