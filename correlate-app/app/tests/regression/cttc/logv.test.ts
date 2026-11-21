/**
 * Regression corpus of cttc's bugs: log viewer (LOGV).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, it } from "vitest";

describe("br-LOGV-000001-sJpO9KMY", () => {
  // BUG-000021-uKKrzikI, High: becomes a real test with roadmap Item 30
  // (RM-000031-sJpO9KMY).
  it.todo("cttc BUG-000021: A failed log page fetch is cached forever");
});
