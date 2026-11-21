/**
 * Regression corpus of cttc's bugs: recording (REC).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, it } from "vitest";

describe("br-REC-000001-sJpO9KMY", () => {
  // BUG-000029-uKKrzikI, High: becomes a real test with roadmap Item 16, Item 40
  // (RM-000017-sJpO9KMY, RM-000041-sJpO9KMY).
  it.todo(
    "cttc BUG-000029: New Gateway and pill switch change the active gateway with no recording check",
  );
});
