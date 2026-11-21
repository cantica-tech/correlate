/**
 * REQ-000030-sJpO9KMY: the cursor's time from a click, the recentre, and the
 * containers' shared order and hidden set.
 */
import { describe, expect, it } from "vitest";
import { PLOT_MARGIN_LEFT } from "../../correlate/axes.js";
import { arrange, moveBy, moveTo } from "../arrange.js";
import { HIGHLIGHT_MS, timeAt } from "../ChartBlock.js";
import { recentred } from "../viewState.js";

describe("REQ-000030-sJpO9KMY: the cursor from a click", () => {
  it("is the time under the click, none left of the plot", () => {
    const view = { t0: 0, t1: 1000 };
    expect(timeAt(PLOT_MARGIN_LEFT, view, PLOT_MARGIN_LEFT + 500)).toBe(0);
    expect(timeAt(PLOT_MARGIN_LEFT + 250, view, PLOT_MARGIN_LEFT + 500)).toBe(500);
    expect(timeAt(PLOT_MARGIN_LEFT - 1, view, 600)).toBeNull();
  });

  it("highlights rows within cttc's 5 s", () => {
    expect(HIGHLIGHT_MS).toBe(5000);
  });
});

describe("br-VIEW-000002-sJpO9KMY: a recentre", () => {
  it("keeps the span, centred on the row's time, never under 200 ms", () => {
    const paused = (view: { t0: number; t1: number }) => ({ view, live: false, resumeAt: null });
    expect(recentred(paused({ t0: 0, t1: 600_000 }), 1_000_000, 0, 10).view).toEqual({
      t0: 700_000,
      t1: 1_300_000,
    });
    expect(recentred(paused({ t0: 0, t1: 50 }), 1000, 0, 10).view).toEqual({ t0: 900, t1: 1100 });
  });
});

describe("REQ-000030-sJpO9KMY: the containers' order and hidden set", () => {
  it("keep the kept order, new containers last, gone ones dropped", () => {
    expect(arrange(["a", "b", "c", "d"], { order: ["c", "x", "a"], hidden: ["x", "a"] })).toEqual({
      order: ["c", "a", "b", "d"],
      hidden: ["a"],
    });
    expect(arrange(["b", "a"], { order: [], hidden: [] })).toEqual({
      order: ["b", "a"],
      hidden: [],
    });
  });

  it("move a container onto another's place, or by the keyboard", () => {
    expect(moveTo(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"]);
    expect(moveTo(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    expect(moveTo(["a", "b"], "a", "zz")).toEqual(["a", "b"]);
    expect(moveBy(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveBy(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
  });
});
