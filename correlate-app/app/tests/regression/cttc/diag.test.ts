/**
 * Regression corpus of cttc's bugs: diagnostics and own logs (DIAG).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, it } from "vitest";

describe("br-DIAG-000002-sJpO9KMY", () => {
  // BUG-000033-uKKrzikI, Medium: becomes a real test with roadmap Item 51
  // (RM-000052-sJpO9KMY).
  it.todo("cttc BUG-000033: Ship Logs throws when the saved log folder is missing");
});
