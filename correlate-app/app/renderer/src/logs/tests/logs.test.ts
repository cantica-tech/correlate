/**
 * The log panels' pages, calls, lanes and CSS (REQ-000029-sJpO9KMY
 * Requirements 2 and 3, br-LOGV-000001-sJpO9KMY, br-STYLE-000001-sJpO9KMY).
 * cttc bug 21's own test is in `tests/regression/cttc/logv.test.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bare, cssBlocks, cttcRules } from "../../testing/cttcCss.js";
import { clock, density, findRow, levelOf, nearestRow, pageFetcher } from "../api.js";
import { LANE_HEIGHT, laneTicks } from "../Lanes.js";
import { PAGE, PageCache, pagesOf, retryDelay } from "../pages.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const view = { t0: Date.parse("2026-11-21T18:00:00Z"), t1: Date.parse("2026-11-21T18:10:00Z") };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("REQ-000029-sJpO9KMY: pages", () => {
  it("are 200 rows, those a range touches", () => {
    expect(PAGE).toBe(200);
    expect(pagesOf(0, 0)).toEqual([0]);
    expect(pagesOf(190, 410)).toEqual([0, 1, 2]);
    expect(pagesOf(5, 4)).toEqual([]);
  });

  it("are fetched once, when in view, and kept", async () => {
    const asked: number[] = [];
    const cache = new PageCache(async (p) => {
      asked.push(p);
      return { rows: [{ ts: "t", text: `p${p}` }], total: 1000 };
    });
    cache.want(0, 30);
    cache.want(0, 30);
    await tick();
    cache.want(10, 250);
    await tick();
    cache.want(0, 30);
    expect(asked).toEqual([0, 1]);
    expect(cache.row(0)?.text).toBe("p0");
    expect(cache.total).toBe(1000);
  });

  it("keep the last read's rows on show until their page comes again", async () => {
    let text = "old";
    const cache = new PageCache(async () => ({ rows: [{ ts: "t", text }], total: 1 }));
    cache.want(0, 0);
    await tick();
    text = "new";
    cache.reset();
    expect(cache.row(0)?.text).toBe("old");
    cache.want(0, 0);
    await tick();
    expect(cache.row(0)?.text).toBe("new");
    cache.clear();
    expect(cache.row(0)).toBeUndefined();
    expect(cache.total).toBeNull();
  });

  it("are retried after 1, 2, 4 ... up to 30 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(retryDelay)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
});

describe("REQ-000029-sJpO9KMY: the calls", () => {
  it("ask the Sump's log routes over the view", async () => {
    const seen: unknown[] = [];
    const request = async (m: unknown) => {
      seen.push(m);
      return { ok: true as const, value: { rows: [], total: 0, index: 7, counts: [1, 2] } };
    };
    await pageFetcher(request, "self/web", view, "oldest")(2);
    expect(seen[0]).toEqual({
      method: "GET",
      path: "/records/logs",
      query: {
        source: "self/web",
        from: "2026-11-21T18:00:00.000Z",
        to: "2026-11-21T18:10:00.000Z",
        offset: 400,
        limit: 200,
        order: "oldest",
      },
    });
    expect(await findRow(request, "s", view, "newest", "boom", -1, "next")).toEqual({
      ok: true,
      index: 7,
    });
    expect(seen[1]).toMatchObject({
      path: "/records/logs/find",
      query: { q: "boom", from_index: -1, direction: "next" },
    });
    expect(await density(request, "s", view, 5000)).toEqual([1, 2]);
    expect(seen[2]).toMatchObject({ path: "/records/density", query: { buckets: 2000 } });
    // REQ-000030-sJpO9KMY: the row nearest the cursor.
    expect(await nearestRow(request, "s", view, "oldest", view.t0 + 1000)).toEqual({
      ok: true,
      index: 7,
    });
    expect(seen[3]).toMatchObject({
      path: "/records/logs/at",
      query: { order: "oldest", t: "2026-11-21T18:00:01.000Z" },
    });
  });

  it("throw on a failed page, so the cache does not keep it", async () => {
    const request = async () => ({
      ok: false as const,
      error: { kind: "network" as const, message: "down" },
    });
    await expect(pageFetcher(request, "s", view, "newest")(0)).rejects.toThrow("down");
  });
});

describe("REQ-000029-sJpO9KMY: rows", () => {
  it("are marked by cttc's levels, their time as cttc's clock", () => {
    expect(levelOf("2026 ERROR boom")).toBe("error");
    expect(levelOf("fatal: x")).toBe("error");
    expect(levelOf("WARNING low disk")).toBe("warn");
    expect(levelOf("all fine")).toBeNull();
    expect(clock(new Date(2026, 10, 21, 9, 5, 7, 42).getTime())).toBe("09:05:07.042");
  });
});

describe("REQ-000029-sJpO9KMY: the lanes", () => {
  it("draw cttc's ticks: one per bucket with rows, stronger where busier", () => {
    expect(LANE_HEIGHT).toBe(8);
    expect(laneTicks([0, 2, 4, 0], 400, 40)).toEqual([
      { x: 140, width: 99.5, alpha: 0.35 + 0.65 * 0.5 },
      { x: 240, width: 99.5, alpha: 1 },
    ]);
    expect(laneTicks([], 400, 40)).toEqual([]);
    expect(laneTicks([1, 1, 1, 1], 2, 0)[0]?.width).toBe(1);
  });
});

describe("br-STYLE-000001-sJpO9KMY: logs.css is cttc's", () => {
  const blocks = cssBlocks(readFileSync(path.join(here, "../logs.css"), "utf8"));

  it.each(blocks.map((b) => [`${b.from}-${b.to}`, b] as const))(
    "block %s is cttc's lines",
    (_n, block) => {
      expect(block.from).toBeDefined();
      expect(bare(block.body)).toBe(cttcRules(block.from as number, block.to as number));
    },
  );
});
