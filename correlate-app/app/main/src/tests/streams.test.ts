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

  it("asks before changing the stream while a recording is live, and abandons it once confirmed (REQ-000039-sJpO9KMY)", async () => {
    const handlers = new Map<string, (event: unknown, message: unknown) => unknown>();
    let live: string | undefined = "in progress";
    let abandoned = 0;
    const guard = {
      liveRecording: () => live,
      abandon: async () => {
        abandoned++;
        live = undefined;
      },
    };
    registerStreamIpc(
      { handle: (c, f) => void handlers.set(c, f as never) },
      new ActiveStreams(),
      { get: () => "local" },
      guard,
    );
    const set = (m: unknown) =>
      (handlers.get(STREAM_SET_ACTIVE_CHANNEL) as (e: unknown, m: unknown) => unknown)(
        { sender: { id: 1 } },
        m,
      );
    // The window's first stream changes nothing recorded; the same one neither.
    expect(await set("self")).toEqual({ ok: true, stream: "self" });
    expect(await set("self")).toEqual({ ok: true, stream: "self" });
    expect(await set("other")).toMatchObject({ ok: false, step: "confirm" });
    expect(abandoned).toBe(0);
    expect(await set({ stream: "other", confirmed: true })).toEqual({ ok: true, stream: "other" });
    expect(abandoned).toBe(1);
    // Idle: no question.
    expect(await set("self")).toEqual({ ok: true, stream: "self" });
  });
});
