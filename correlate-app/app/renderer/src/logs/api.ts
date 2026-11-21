/**
 * The log panels' and lanes' calls to the window's Sump (REQ-000029-sJpO9KMY),
 * through the Sump bridge only (br-CONN-000008-sJpO9KMY): a page of rows by
 * index, the next or previous match of a search, and the rows' count per
 * bucket.
 */
import type { Viewport } from "../correlate/atoms.js";
import type { SumpRequester } from "../shell/bridge.js";
import { type FetchPage, PAGE, type PageReply } from "./pages.js";

/** Newest first (cttc's default) or oldest first. */
export type Order = "newest" | "oldest";

/** The time range of a query. */
function range(view: Viewport) {
  return { from: new Date(view.t0).toISOString(), to: new Date(view.t1).toISOString() };
}

/** A failed call, as an error. */
function failure(reply: { ok: false; error: { message: string } }): Error {
  return new Error(reply.error.message);
}

/** The pages of `source` over `view` in `order`. */
export function pageFetcher(
  request: SumpRequester,
  source: string,
  view: Viewport,
  order: Order,
): FetchPage {
  return async (page) => {
    const reply = await request({
      method: "GET",
      path: "/records/logs",
      query: { source, ...range(view), offset: page * PAGE, limit: PAGE, order },
    });
    if (!reply.ok) throw failure(reply);
    return reply.value as PageReply;
  };
}

/** The index of the next (or previous) row after (before) `fromIndex` containing `q`. */
export async function findRow(
  request: SumpRequester,
  source: string,
  view: Viewport,
  order: Order,
  q: string,
  fromIndex: number,
  direction: "next" | "previous",
): Promise<{ ok: true; index: number | null } | { ok: false; message: string }> {
  const reply = await request({
    method: "GET",
    path: "/records/logs/find",
    query: { source, ...range(view), order, q, from_index: fromIndex, direction },
  });
  if (!reply.ok) return { ok: false, message: reply.error.message };
  return { ok: true, index: (reply.value as { index: number | null }).index };
}

/** The index of `source`'s row nearest `t` over `view` in `order`, or null with no rows. */
export async function nearestRow(
  request: SumpRequester,
  source: string,
  view: Viewport,
  order: Order,
  t: number,
): Promise<{ ok: true; index: number | null } | { ok: false; message: string }> {
  const reply = await request({
    method: "GET",
    path: "/records/logs/at",
    query: { source, ...range(view), order, t: new Date(t).toISOString() },
  });
  if (!reply.ok) return { ok: false, message: reply.error.message };
  return { ok: true, index: (reply.value as { index: number | null }).index };
}

/** How many rows of `source` fall in each of `buckets` buckets of `view`. */
export async function density(
  request: SumpRequester,
  source: string,
  view: Viewport,
  buckets: number,
): Promise<number[] | null> {
  const reply = await request({
    method: "GET",
    path: "/records/density",
    query: { source, ...range(view), buckets: Math.max(1, Math.min(2000, Math.floor(buckets))) },
  });
  return reply.ok ? (reply.value as { counts: number[] }).counts : null;
}

/** cttc's level marks (`app.js:2630`): error, warn, or none. */
export function levelOf(text: string): "error" | "warn" | null {
  if (/\b(ERROR|FATAL|CRIT)/i.test(text)) return "error";
  if (/\bWARN/i.test(text)) return "warn";
  return null;
}

/** cttc's `fmtClock(ms, true)`: local `HH:MM:SS.mmm`. */
export function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
