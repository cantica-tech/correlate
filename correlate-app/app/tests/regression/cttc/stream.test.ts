/**
 * Regression corpus of cttc's bugs: data-stream management (STREAM).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus. Bugs 28 and 31
 * moved to the server's corpus with Item 27, and 30 with Item 28: the Sump
 * keeps the selections and runs collection.
 */
import { describe, expect, it } from "vitest";
import { hostCollected, hostTitle } from "../../../renderer/src/charts/host.js";
import type { Stream } from "../../../renderer/src/streams/api.js";

describe("br-STREAM-000001-sJpO9KMY", () => {
  // BUG-000013-uKKrzikI, Medium: built with roadmap Item 33 (RM-000034-sJpO9KMY).
  it("cttc BUG-000013: Host telemetry block shows for the wrong host or view", () => {
    const followed = { containers: ["web"], services: [] };
    const self: Stream = { id: "self", kind: "self", label: "This Sump's host", followed };
    const lab: Stream = {
      id: "ssh:ops@lab:22",
      kind: "ssh",
      label: "ops@lab:22",
      host: "lab",
      followed,
    };
    // cttc titled the block for the first host source it found, so another
    // host's block read "localhost": the title is the active stream's host.
    expect(hostTitle(self)).toBe("Host telemetry — localhost");
    expect(hostTitle(lab)).toBe("Host telemetry — lab");
    expect(hostTitle(lab)).not.toContain("localhost");
    // cttc kept the block up for a host that was no longer collected: it
    // shows only while the active stream collects.
    expect(hostCollected(lab)).toBe(true);
    expect(hostCollected({ ...lab, paused: true })).toBe(false);
    expect(hostCollected({ ...lab, followed: { containers: [], services: [] } })).toBe(false);
    expect(hostCollected(null)).toBe(false);
  });
});
