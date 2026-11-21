/**
 * The comparison of the parity checks (REQ-000020-sJpO9KMY Requirement 2),
 * on every system: the pictures themselves are only taken on macOS.
 */
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { COMPONENT_LIMIT, compare, readPng, SCREEN_LIMIT, writePng } from "./compare.js";

/** A `width` x `height` picture in one color, with `paint` drawing on it. */
function picture(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number] = () => [240, 240, 240],
): PNG {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

/** The same picture with `n` pixels of the first row in black. */
const withDots = (n: number) =>
  picture(100, 100, (x, y) => (y === 0 && x < n ? [0, 0, 0] : [240, 240, 240]));

describe("br-STYLE-000001-sJpO9KMY: comparing pictures", () => {
  it("passes identical pictures", () => {
    expect(compare(picture(100, 100), picture(100, 100), COMPONENT_LIMIT)).toMatchObject({
      ok: true,
      different: 0,
    });
  });

  it("does not count a difference under the 0.1 color distance", () => {
    const close = picture(100, 100, () => [236, 236, 236]);
    expect(compare(picture(100, 100), close, COMPONENT_LIMIT).different).toBe(0);
  });

  it("passes a component with 0.1% of its pixels different, fails it with more", () => {
    expect(compare(picture(100, 100), withDots(10), COMPONENT_LIMIT).ok).toBe(true);
    const over = compare(picture(100, 100), withDots(11), COMPONENT_LIMIT);
    expect(over).toMatchObject({ ok: false, different: 11 });
    expect(over.reason).toMatch(/11 pixels differ \(0\.110%, at most 0\.1% allowed\)/);
  });

  it("allows a screen 0.5%", () => {
    expect(compare(picture(100, 100), withDots(50), SCREEN_LIMIT).ok).toBe(true);
    expect(compare(picture(100, 100), withDots(51), SCREEN_LIMIT).ok).toBe(false);
  });

  it("fails pictures of different sizes", () => {
    const result = compare(picture(100, 100), picture(100, 101), SCREEN_LIMIT);
    expect(result).toMatchObject({
      ok: false,
      reason: "sizes differ: expected 100x100, got 100x101",
    });
  });

  it("leaves masked regions out, and only them", () => {
    const clock = picture(100, 100, (x, y) => (x >= 80 && y >= 90 ? [0, 0, 0] : [240, 240, 240]));
    const mask = { x: 80, y: 90, width: 20, height: 10, reason: "the clock" };
    expect(compare(picture(100, 100), clock, COMPONENT_LIMIT, [mask]).different).toBe(0);
    expect(
      compare(picture(100, 100), clock, COMPONENT_LIMIT, [{ ...mask, width: 10 }]).different,
    ).toBe(100);
  });

  it("does not change the picture it was given", () => {
    const actual = withDots(5);
    compare(picture(100, 100), actual, COMPONENT_LIMIT, [
      { x: 0, y: 0, width: 5, height: 1, reason: "r" },
    ]);
    expect(actual.data[0]).toBe(0);
  });

  it("reads back what it writes", () => {
    const png = withDots(3);
    expect(compare(png, readPng(writePng(png)), 0).ok).toBe(true);
  });
});
