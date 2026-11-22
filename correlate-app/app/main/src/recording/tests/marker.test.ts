import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markerDeps, readMarker } from "../ipc.js";

// REQ-000038-sJpO9KMY Requirement 1: the marker's file.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "marker-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const marker = {
  status: "paused" as const,
  target: { sump: "local", stream: "self", containers: ["web"], host: false },
  segments: [{ from: 1, to: 2 }],
  segmentStart: null,
  pieceStart: null,
  startedAt: 1,
};

describe("REQ-000038-sJpO9KMY: the recording's marker", () => {
  it("is written, read back, and removed when idle", async () => {
    const file = path.join(dir, "recording-marker.json");
    const { saveMarker } = markerDeps(file);
    await saveMarker?.(marker);
    expect(await readMarker(file, () => {})).toEqual(marker);
    await saveMarker?.(null);
    expect(existsSync(file)).toBe(false);
    expect(await readMarker(file, () => {})).toBeNull();
  });

  it("is set aside and said when damaged", async () => {
    const file = path.join(dir, "recording-marker.json");
    writeFileSync(file, "{ nope");
    const told: string[] = [];
    expect(await readMarker(file, (t) => told.push(t))).toBeNull();
    expect(readdirSync(dir).some((f) => f.startsWith("recording-marker.json.damaged-"))).toBe(true);
    expect(told).toEqual(["A previous recording's marker was damaged and set aside"]);
  });
});
