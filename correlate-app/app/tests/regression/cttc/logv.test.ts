/**
 * Regression corpus of cttc's bugs: log viewer (LOGV).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, expect, it } from "vitest";
import { PageCache } from "../../../renderer/src/logs/pages.js";

describe("br-LOGV-000001-sJpO9KMY", () => {
  // BUG-000021-uKKrzikI, High: built with roadmap Item 30 (RM-000031-sJpO9KMY).
  it("cttc BUG-000021: A failed log page fetch is cached forever", async () => {
    let fail = true;
    let asked = 0;
    const timers: { run: () => void; ms: number }[] = [];
    const logged: string[] = [];
    const cache = new PageCache(
      async () => {
        asked++;
        if (fail) throw new Error("Sump unreachable");
        return { rows: [{ ts: "2026-11-21T18:00:00Z", text: "hello" }], total: 1 };
      },
      {
        schedule: (run, ms) => timers.push({ run, ms }),
        cancel: () => {},
        log: (m) => logged.push(m),
      },
    );
    const settle = () => new Promise((r) => setTimeout(r, 0));

    // The page fails: nothing is kept, the row reads as loading, a retry waits 1 s.
    cache.want(0, 10);
    await settle();
    expect(cache.row(0)).toBeUndefined();
    expect(cache.has(0)).toBe(false);
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    expect(logged[0]).toContain("Sump unreachable");

    // It fails again: the next retry waits twice as long.
    timers.shift()?.run();
    await settle();
    expect(asked).toBe(2);
    expect(timers.map((t) => t.ms)).toEqual([2000]);

    // The Sump is back: the retry brings the rows, unlike cttc's cached rejection.
    fail = false;
    timers.shift()?.run();
    await settle();
    expect(asked).toBe(3);
    expect(cache.row(0)?.text).toBe("hello");

    // A failed page out of view is fetched at once when it comes back into view.
    const again = new PageCache(
      async () => {
        if (fail) throw new Error("down");
        return { rows: [{ ts: "t", text: "back" }], total: 1 };
      },
      { schedule: (run, ms) => timers.push({ run, ms }), cancel: () => {}, log: () => {} },
    );
    fail = true;
    again.want(0, 0);
    await settle();
    again.want(500, 600);
    fail = false;
    again.want(0, 0);
    await settle();
    expect(again.row(0)?.text).toBe("back");
  });
});
