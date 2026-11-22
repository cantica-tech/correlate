/**
 * The stream host's own telemetry in the app (REQ-000032-sJpO9KMY): its
 * records' name, the block's title, and when the block shows. Pure.
 */
import type { Stream } from "../streams/api.js";

/** The host's records within a stream: `<stream>/__host__` (the Sump's `HOST_NAME`). */
export const HOST_NAME = "__host__";

/**
 * cttc's `hostTelemetryLabel`: "Host telemetry — <host>" for the window's
 * active stream; "localhost" only for the Sump's own host, never for another
 * (br-STREAM-000001-sJpO9KMY, cttc bug 13).
 */
export function hostTitle(stream: Stream): string {
  if (stream.kind === "self") return "Host telemetry — localhost";
  return `Host telemetry — ${stream.host || stream.label}`;
}

/** The Sump reads a stream's host while the stream collects: it follows something and is not paused. */
export function hostCollected(stream: Stream | null): boolean {
  if (!stream || stream.paused) return false;
  const followed = stream.followed;
  return (followed?.containers.length ?? 0) + (followed?.services.length ?? 0) > 0;
}
