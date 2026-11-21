import { describe, expect, it } from "vitest";
import {
  ActiveStreams,
  registerStreamIpc,
  STREAM_ACTIVE_CHANNEL,
  STREAM_SET_ACTIVE_CHANNEL,
} from "../streams.js";

// REQ-000027-sJpO9KMY Requirement 3: each window's active data stream.

describe("REQ-000027-sJpO9KMY: the active stream", () => {
  it("is per window, and belongs to the Sump it was set on", () => {
    const streams = new ActiveStreams();
    streams.set(1, "local", "self");
    streams.set(2, "local", "ssh:ops@lab:22");
    expect(streams.get(1, "local")).toBe("self");
    expect(streams.get(2, "local")).toBe("ssh:ops@lab:22");
    // Window 1 moved to another Sump: no active stream there yet.
    expect(streams.get(1, "remote-1")).toBeNull();
    streams.close(2);
    expect(streams.get(2, "local")).toBeNull();
  });

  it.each([[""], ["a b"], ["x".repeat(201)], [7]])("refuses %j", (stream) => {
    expect(() => new ActiveStreams().set(1, "local", stream)).toThrow(/200 printable/);
  });

  it("answers the bridge for the calling window on its Sump", async () => {
    const handlers = new Map<string, (event: unknown, message: unknown) => unknown>();
    const sumpOf = new Map<number, string>([[1, "local"]]);
    registerStreamIpc({ handle: (c, f) => void handlers.set(c, f as never) }, new ActiveStreams(), {
      get: (w: number) => sumpOf.get(w),
    });
    const call = (c: string, window: number, m?: unknown) =>
      (handlers.get(c) as (e: unknown, m: unknown) => unknown)({ sender: { id: window } }, m);
    expect(await call(STREAM_ACTIVE_CHANNEL, 1)).toBeNull();
    expect(await call(STREAM_SET_ACTIVE_CHANNEL, 1, "self")).toEqual({ ok: true, stream: "self" });
    expect(await call(STREAM_ACTIVE_CHANNEL, 1)).toBe("self");
    expect(await call(STREAM_SET_ACTIVE_CHANNEL, 2, "self")).toMatchObject({ ok: false });
    expect(await call(STREAM_SET_ACTIVE_CHANNEL, 1, "")).toMatchObject({ ok: false });
  });
});
