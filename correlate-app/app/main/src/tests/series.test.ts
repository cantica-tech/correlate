import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  arrangement,
  registerSeriesIpc,
  SERIES_GET_CHANNEL,
  SERIES_SET_CHANNEL,
  setArrangement,
} from "../series.js";
import { Settings } from "../theme.js";

// REQ-000030-sJpO9KMY Requirement 4: each stream's containers' order and hidden set.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "series-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const quiet = { warn: () => {} };
const settings = () => new Settings(path.join(dir, "settings.json"), quiet);

describe("REQ-000030-sJpO9KMY: the containers' arrangement", () => {
  it("is kept per Sump and stream, across restarts", () => {
    setArrangement(settings(), "local", { stream: "self", order: ["web", "db"], hidden: ["db"] });
    setArrangement(settings(), "remote", { stream: "self", order: ["api"], hidden: [] });
    expect(arrangement(settings(), "local", "self")).toEqual({
      order: ["web", "db"],
      hidden: ["db"],
    });
    expect(arrangement(settings(), "remote", "self")).toEqual({ order: ["api"], hidden: [] });
    expect(arrangement(settings(), "local", "ssh:ops@lab:22")).toEqual({ order: [], hidden: [] });
  });

  it.each([
    [{ stream: "a b", order: [], hidden: [] }],
    [{ stream: "self", order: "web", hidden: [] }],
    [{ stream: "self", order: ["we b"], hidden: [] }],
    [{ stream: "self", order: [], hidden: [7] }],
  ])("refuses %j", (message) => {
    expect(() => setArrangement(settings(), "local", message)).toThrow();
  });

  it("answers on the calling window's Sump, none without one", async () => {
    const handlers = new Map<string, (e: { sender: { id: number } }, m: unknown) => unknown>();
    registerSeriesIpc({ handle: (c, l) => void handlers.set(c, l) }, settings(), {
      get: (id: number) => (id === 1 ? "local" : undefined),
    });
    const set = handlers.get(SERIES_SET_CHANNEL);
    const get = handlers.get(SERIES_GET_CHANNEL);
    expect(
      await set?.({ sender: { id: 1 } }, { stream: "self", order: ["web"], hidden: [] }),
    ).toMatchObject({
      ok: true,
    });
    expect(await get?.({ sender: { id: 1 } }, "self")).toEqual({ order: ["web"], hidden: [] });
    expect(await get?.({ sender: { id: 2 } }, "self")).toEqual({ order: [], hidden: [] });
    expect(
      await set?.({ sender: { id: 2 } }, { stream: "self", order: [], hidden: [] }),
    ).toMatchObject({
      ok: false,
    });
  });
});
