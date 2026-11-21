/**
 * The containers' order and hidden set (REQ-000030-sJpO9KMY Requirement 4):
 * the legend and the log panels share them. Pure: the kept arrangement
 * applied to what the stream follows now, and moves.
 */

/** A stream's containers, in order, and those hidden. */
export interface Arranged {
  order: string[];
  hidden: string[];
}

/**
 * `followed` in the kept order: those kept first, as kept, then those new to
 * the stream as they come; those no longer followed dropped, from the hidden
 * set too.
 */
export function arrange(followed: readonly string[], kept: Arranged): Arranged {
  const now = new Set(followed);
  const known = kept.order.filter((n) => now.has(n));
  const fresh = followed.filter((n) => !known.includes(n));
  return { order: [...known, ...fresh], hidden: kept.hidden.filter((n) => now.has(n)) };
}

/** `order` with `name` moved to where `target` is (cttc's drop on an entry). */
export function moveTo(order: readonly string[], name: string, target: string): string[] {
  const from = order.indexOf(name);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = order.filter((n) => n !== name);
  next.splice(to, 0, name);
  return next;
}

/** `order` with `name` moved `delta` places, kept inside the list (the keyboard's move). */
export function moveBy(order: readonly string[], name: string, delta: number): string[] {
  const from = order.indexOf(name);
  if (from < 0) return [...order];
  const to = Math.max(0, Math.min(order.length - 1, from + delta));
  const next = order.filter((n) => n !== name);
  next.splice(to, 0, name);
  return next;
}

/** The type a dragged container carries, between the legend and the panels. */
export const DRAG_TYPE = "text/x-correlate-container";
