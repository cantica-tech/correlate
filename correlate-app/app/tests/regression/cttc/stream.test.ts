/**
 * Regression corpus of cttc's bugs: data-stream management (STREAM).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus. Bugs 28 and 31
 * moved to the server's corpus with Item 27: the Sump keeps the selections.
 */
import { describe, it } from "vitest";

describe("br-STREAM-000001-sJpO9KMY", () => {
  // BUG-000013-uKKrzikI, Medium: becomes a real test with roadmap Item 28
  // (RM-000029-sJpO9KMY).
  it.todo("cttc BUG-000013: Host telemetry block shows for the wrong host or view");
});

describe("br-STREAM-000004-sJpO9KMY", () => {
  // BUG-000030-uKKrzikI, Medium: becomes a real test with roadmap Item 28
  // (RM-000029-sJpO9KMY).
  it.todo("cttc BUG-000030: Removing an inactive but connected Docker host leaves it collecting");
});
