/**
 * Picture comparison for the visual parity checks (br-STYLE-000001-sJpO9KMY,
 * REQ-000020-sJpO9KMY Requirement 2), as decided in FEAT-000021-sJpO9KMY: a
 * pixel differs past a 0.1 color distance (pixelmatch's threshold); a
 * component passes with at most 0.1% of its pixels different, a screen with
 * at most 0.5%; masked regions (live data, times) are left out; pictures of
 * different sizes fail.
 */
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** At most this share of a component's pixels may differ. */
export const COMPONENT_LIMIT = 0.001;
/** At most this share of a screen's pixels may differ. */
export const SCREEN_LIMIT = 0.005;
/** The color distance past which a pixel counts as different. */
export const PIXEL_THRESHOLD = 0.1;

/** A region left out of the comparison, in the pictures' own pixels. */
export interface Mask {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Why it is left out: what it shows that changes from run to run. */
  reason: string;
}

/** What a comparison found. */
export interface Comparison {
  ok: boolean;
  /** Pixels that differ, of those compared. */
  different: number;
  /** Their share of every pixel of the picture. */
  ratio: number;
  /** The difference drawn in red over a faded copy; undefined on a size mismatch. */
  diff?: PNG;
  /** Why it failed, for the test's message. */
  reason?: string;
}

/** Paint every mask of `to` with the pixels of `from`, so they compare equal. */
function applyMasks(from: PNG, to: PNG, masks: readonly Mask[]): void {
  for (const m of masks) {
    for (let y = Math.max(0, m.y); y < Math.min(to.height, m.y + m.height); y += 1) {
      for (let x = Math.max(0, m.x); x < Math.min(to.width, m.x + m.width); x += 1) {
        const i = (y * to.width + x) * 4;
        from.data.copy(to.data, i, i, i + 4);
      }
    }
  }
}

/** Compare `actual` with `expected`; `limit` is the share of pixels allowed to differ. */
export function compare(
  expected: PNG,
  actual: PNG,
  limit: number,
  masks: readonly Mask[] = [],
): Comparison {
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      ok: false,
      different: Number.NaN,
      ratio: 1,
      reason: `sizes differ: expected ${expected.width}x${expected.height}, got ${actual.width}x${actual.height}`,
    };
  }
  const masked = new PNG({ width: actual.width, height: actual.height });
  actual.data.copy(masked.data);
  applyMasks(expected, masked, masks);
  const diff = new PNG({ width: actual.width, height: actual.height });
  const different = pixelmatch(expected.data, masked.data, diff.data, actual.width, actual.height, {
    threshold: PIXEL_THRESHOLD,
  });
  const ratio = different / (actual.width * actual.height);
  const ok = ratio <= limit;
  return {
    ok,
    different,
    ratio,
    diff,
    reason: ok
      ? undefined
      : `${different} pixels differ (${(ratio * 100).toFixed(3)}%, at most ${(limit * 100).toFixed(1)}% allowed)`,
  };
}

/** Read a PNG from its bytes. */
export function readPng(bytes: Buffer): PNG {
  return PNG.sync.read(bytes);
}

/** A PNG's bytes. */
export function writePng(png: PNG): Buffer {
  return PNG.sync.write(png);
}
