/**
 * Regression corpus of cttc's bugs: event artifacts in the app (EVENT).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, it } from "vitest";

describe("br-EVENT-000005-sJpO9KMY", () => {
  // BUG-000026-uKKrzikI, High: becomes a real test with roadmap Item 48
  // (RM-000049-sJpO9KMY).
  it.todo("cttc BUG-000026: Event recording download is saved without a status check");
});
