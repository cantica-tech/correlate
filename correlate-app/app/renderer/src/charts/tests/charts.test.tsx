/**
 * The charts' strips (REQ-000028-sJpO9KMY Requirements 2 and 3): what each
 * asks the Sump, the points its answer makes, the 200 ms floor, and
 * `charts.css` held to cttc's rules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bare, cssBlocks, cttcRules } from "../../testing/cttcCss.js";
import { percentCeiling } from "../ChartBlock.js";
import { bucketsQuery, bucketsToPoints, DEFAULT_SPAN_MS, STRIPS, viewEndingAt } from "../strips.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-21T18:10:00Z");

describe("REQ-000028-sJpO9KMY: the strips", () => {
  it("are cttc's CPU %, MEM % and NET", () => {
    expect(STRIPS.map((s) => s.title)).toEqual(["CPU %", "MEM %", "NET"]);
  });

  it("ask the buckets route for each strip's fields, percentage or rate", () => {
    const view = viewEndingAt(NOW);
    const [cpu, mem, net] = STRIPS;
    expect(bucketsQuery(cpu as never, "self/web", view, 640.7)).toEqual({
      source: "self/web",
      from: "2026-11-21T18:00:00.000Z",
      to: "2026-11-21T18:10:00.000Z",
      buckets: 640,
      mode: "max",
      field: "cpu_percent",
    });
    expect(bucketsQuery(mem as never, "self/web", view, 10)).toMatchObject({
      field: "mem_used_bytes",
      over: "mem_limit_bytes",
    });
    expect(bucketsQuery(net as never, "self/web", view, 10)).toMatchObject({
      field: "net_rx_bytes,net_tx_bytes",
      mode: "rate",
    });
    expect(bucketsQuery(cpu as never, "s", view, 50_000).buckets).toBe(2000);
  });

  it("make points at each bucket's middle, empty ones left out, NET in kB/s", () => {
    const view = { t0: 0, t1: 1000 };
    expect(bucketsToPoints([1, null, 3, null], view)).toEqual([
      { t: 125, v: 1 },
      { t: 625, v: 3 },
    ]);
    expect(bucketsToPoints([2500], view, 1000)).toEqual([{ t: 500, v: 2.5 }]);
  });
});

describe("REQ-000028-sJpO9KMY: a percentage strip's top", () => {
  it("is 100, or the data's top rounded up when a container uses several cores", () => {
    expect(percentCeiling([{ points: [{ t: 0, v: 40 }] }])).toBe(100);
    expect(percentCeiling([{ points: [{ t: 0, v: 101.5 }] }, { points: [] }])).toBe(110);
    expect(percentCeiling([])).toBe(100);
  });
});

describe("br-VIEW-000002-sJpO9KMY: the view", () => {
  it("shows the last 10 minutes, and is never narrower than 200 ms", () => {
    expect(viewEndingAt(NOW)).toEqual({ t0: NOW - DEFAULT_SPAN_MS, t1: NOW });
    expect(viewEndingAt(NOW, 50)).toEqual({ t0: NOW - 200, t1: NOW });
  });
});

describe("br-STYLE-000001-sJpO9KMY: charts.css is cttc's", () => {
  const ours = readFileSync(path.join(here, "../charts.css"), "utf8");
  const blocks = cssBlocks(ours);

  it.each(blocks.map((b) => [`${b.from}-${b.to}`, b] as const))(
    "block %s is cttc's lines",
    (_n, block) => {
      expect(block.from).toBeDefined();
      expect(bare(block.body)).toBe(cttcRules(block.from as number, block.to as number));
    },
  );
});
