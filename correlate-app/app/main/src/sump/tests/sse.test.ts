import { describe, expect, it } from "vitest";
import { SseParser } from "../sse.js";

// br-CONN-000009-sJpO9KMY (REQ-000007-sJpO9KMY Requirement 2): the client
// reads the Sump's event streams, heartbeats included.

const bytes = (text: string) => new TextEncoder().encode(text);

describe("br-CONN-000009-sJpO9KMY: SSE parsing", () => {
  it("reads named events, ids and multi-line data", () => {
    const parser = new SseParser();
    expect(parser.push(bytes("event: log\nid: 7\ndata: a\ndata: b\n\n"))).toEqual([
      { event: "log", id: "7", data: "a\nb" },
    ]);
  });

  it("produces no event for a heartbeat", () => {
    expect(new SseParser().push(bytes(": keep-alive\n\n"))).toEqual([]);
  });

  it("joins events split across chunks, CRLF included", () => {
    const parser = new SseParser();
    expect(parser.push(bytes("data: he"))).toEqual([]);
    expect(parser.push(bytes("llo\r"))).toEqual([]);
    expect(parser.push(bytes("\n\r\n"))).toEqual([{ event: "message", data: "hello" }]);
  });

  it("joins a character split across chunks", () => {
    const parser = new SseParser();
    const all = bytes("data: é\n\n");
    expect(parser.push(all.slice(0, 7))).toEqual([]);
    expect(parser.push(all.slice(7))).toEqual([{ event: "message", data: "é" }]);
  });
});
