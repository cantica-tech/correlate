/**
 * Which data stream a window shows (REQ-000027-sJpO9KMY Requirement 3): its
 * active one while the Sump still has it; else the picker's last stream on
 * this Sump, "self", or the first stream; else none.
 */
import type { Stream } from "./api.js";

/** The stream a window should be on, given what it was on and what is there. */
export function healActive(
  active: string | null,
  streams: readonly Stream[],
  last: string | null,
): string | null {
  const ids = new Set(streams.map((s) => s.id));
  if (active && ids.has(active)) return active;
  if (last && ids.has(last)) return last;
  if (ids.has("self")) return "self";
  return streams[0]?.id ?? null;
}

/** cttc's pill states for the active stream: collecting, paused or gone, or not known. */
export function streamPillState(stream: Stream | undefined): "up" | "down" | "checking" {
  if (!stream) return "checking";
  if (stream.paused) return "down";
  return (stream.following ?? 0) > 0 ? "up" : "checking";
}

/** Where a stream is, as the switcher's second line. */
export function streamWhere(stream: Stream): string {
  return stream.kind === "self" ? "the Sump's own host" : stream.id.replace(/^ssh:/, "");
}

/** Current Status's rows for a stream. */
export function streamRows(stream: Stream): [string, string][] {
  return [
    ["Data stream", stream.label],
    ["Kind", stream.kind === "self" ? "the Sump's host" : "SSH"],
    ["Following", String(stream.following ?? 0)],
    [
      "Collecting",
      stream.paused ? "paused" : (stream.following ?? 0) > 0 ? "yes" : "nothing followed",
    ],
  ];
}
