import { describe, expect, it } from "vitest";
import {
  centerAtFraction,
  dragThumb,
  NAV_MIN_HISTORY_MS,
  navExtent,
  thumbLayout,
} from "../navLayout.js";

// cor-CORE.CORRELATE-000011 (REQ-000039): the timeline navigator's layout math.
// correlator's two `Navigator` component tests are not ported: the component
// is rebuilt in Phase 6 of docs/roadmap/correlate-app-rewrite.md.

const HOUR = NAV_MIN_HISTORY_MS;

describe("cor-CORE.CORRELATE-000011: navigator layout", () => {
  it("spans at least the last hour, and always the view and now", () => {
    const now = 10 * HOUR;
    expect(navExtent({ t0: now - HOUR / 4, t1: now }, now)).toEqual({ t0: now - HOUR, t1: now });
    expect(navExtent({ t0: now - 3 * HOUR, t1: now + 1000 }, now)).toEqual({
      t0: now - 3 * HOUR,
      t1: now + 1000,
    });
  });

  it("places the thumb as fractions of the track", () => {
    expect(thumbLayout({ t0: 25, t1: 50 }, { t0: 0, t1: 100 })).toEqual({
      left: 0.25,
      width: 0.25,
    });
  });

  it("clicking centers the view at that point, keeping the span", () => {
    expect(centerAtFraction({ t0: 0, t1: 10 }, { t0: 0, t1: 100 }, 0.5)).toEqual({
      t0: 45,
      t1: 55,
    });
  });

  it("dragging the thumb pans by the dragged fraction of the extent", () => {
    expect(dragThumb({ t0: 10, t1: 20 }, { t0: 0, t1: 100 }, -0.1)).toEqual({ t0: 0, t1: 10 });
  });
});
