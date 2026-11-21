/**
 * Regression corpus of cttc's bugs: connection, startup and identity (CONN).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, it } from "vitest";

describe("br-CONN-000005-sJpO9KMY", () => {
  // BUG-000020-uKKrzikI, High: becomes a real test with roadmap Item 8
  // (RM-000009-sJpO9KMY).
  it.todo("cttc BUG-000020: Raw fetches to the gateway have no timeout");
});
