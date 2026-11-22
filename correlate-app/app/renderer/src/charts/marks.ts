/**
 * The vertical marks on the strips and lanes (REQ-000031-sJpO9KMY), cttc's
 * `drawVerticals` (`app.js:826-860`) with its default colors, decided in
 * FEAT-000032-sJpO9KMY: the cursor in the accent, live tracking's cursor as a
 * soft green bar, and the dotted teal now line.
 */
import { NOW_LINE_DASH } from "../correlate/chartDraw.js";

import { appearance } from "../theme/appearance.js";

/** cttc's marks are 1.5 px. */
const MARK_WIDTH = 1.5;

/** A vertical line at `x`, `height` tall. */
function line(ctx: CanvasRenderingContext2D, x: number, height: number, dash: number[] = []) {
  ctx.lineWidth = MARK_WIDTH;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** The cursor at `x`: a soft green bar under a line while live tracking moves it, else an accent line. */
export function drawCursorMark(
  ctx: CanvasRenderingContext2D,
  x: number,
  height: number,
  live: boolean,
  accent: string,
): void {
  if (live) {
    ctx.fillStyle = appearance().liveTrackColor;
    ctx.globalAlpha = 0.25;
    ctx.fillRect(x - 3, 0, 6, height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = appearance().liveTrackColor;
  } else {
    ctx.strokeStyle = accent;
  }
  line(ctx, x, height);
}

/** The now line at `x`, in the Appearance pane's color and style (teal, dotted by default). */
export function drawNowMark(ctx: CanvasRenderingContext2D, x: number, height: number): void {
  const { nowColor, nowStyle } = appearance();
  ctx.strokeStyle = nowColor;
  line(ctx, x, height, NOW_LINE_DASH[nowStyle]);
}
