/**
 * Regression corpus of cttc's bugs: data-stream management (STREAM).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, it } from "vitest";

describe("br-STREAM-000001-sJpO9KMY", () => {
  // BUG-000013-uKKrzikI, Medium: becomes a real test with roadmap Item 28
  // (RM-000029-sJpO9KMY).
  it.todo("cttc BUG-000013: Host telemetry block shows for the wrong host or view");
});

describe("br-STREAM-000003-sJpO9KMY", () => {
  // BUG-000028-uKKrzikI, High: becomes a real test with roadmap Item 27
  // (RM-000028-sJpO9KMY).
  it.todo("cttc BUG-000028: Relaunch replays every historical Set request");
});

describe("br-STREAM-000004-sJpO9KMY", () => {
  // BUG-000030-uKKrzikI, Medium: becomes a real test with roadmap Item 28
  // (RM-000029-sJpO9KMY).
  it.todo("cttc BUG-000030: Removing an inactive but connected Docker host leaves it collecting");
});

describe("br-STREAM-000005-sJpO9KMY", () => {
  // BUG-000031-uKKrzikI, Medium: becomes a real test with roadmap Item 27
  // (RM-000028-sJpO9KMY).
  it.todo("cttc BUG-000031: Container selection file ignores the ssh port");
});
