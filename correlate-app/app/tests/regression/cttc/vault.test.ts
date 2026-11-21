/**
 * Regression corpus of cttc's bugs: key vault and secrets (VAULT).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, it } from "vitest";

describe("br-VAULT-000004-sJpO9KMY", () => {
  // BUG-000009-uKKrzikI, Critical: becomes a real test with roadmap Item 10
  // (RM-000011-sJpO9KMY).
  it.todo("cttc BUG-000009: vault-setup can re-key an already initialized vault");
});

describe("br-VAULT-000006-sJpO9KMY", () => {
  // BUG-000010-uKKrzikI, Critical: becomes a real test with roadmap Item 10
  // (RM-000011-sJpO9KMY).
  it.todo("cttc BUG-000010: API token file is written with default permissions");
});
