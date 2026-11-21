/**
 * Regression corpus of cttc's bugs: Sump management and transport (SUMP).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, it } from "vitest";

describe("br-SUMP-000006-sJpO9KMY", () => {
  // BUG-000001-uKKrzikI, Critical: becomes a real test with roadmap Item 18
  // (RM-000019-sJpO9KMY).
  it.todo("cttc BUG-000001: PowerShell command injection via peer gateway host");
});

describe("br-SUMP-000005-sJpO9KMY", () => {
  // BUG-000002-uKKrzikI, Medium: becomes a real test with roadmap Item 18
  // (RM-000019-sJpO9KMY).
  it.todo("cttc BUG-000002: Telnet fallback reports open ports as closed");
});

describe("br-SUMP-000001-sJpO9KMY", () => {
  // BUG-000003-uKKrzikI, Critical: becomes a real test with roadmap Item 13
  // (RM-000014-sJpO9KMY).
  it.todo("cttc BUG-000003: Corrupt gateways.json is silently overwritten");
});

describe("br-SUMP-000002-sJpO9KMY", () => {
  // BUG-000004-uKKrzikI, High: becomes a real test with roadmap Item 16
  // (RM-000017-sJpO9KMY).
  it.todo("cttc BUG-000004: Uninstalled gateway's host can never be re-added");
});

describe("br-SUMP-000003-sJpO9KMY", () => {
  // BUG-000005-uKKrzikI, High: becomes a real test with roadmap Item 16, Item 17
  // (RM-000017-sJpO9KMY, RM-000018-sJpO9KMY).
  it.todo("cttc BUG-000005: Failed switch to a remote gateway tears down the current tunnel");
  // BUG-000006-uKKrzikI, Medium: becomes a real test with roadmap Item 15
  // (RM-000016-sJpO9KMY).
  it.todo(
    "cttc BUG-000006: Choosing 'Later' after adding a gateway leaves the window on a dead connection",
  );
  // BUG-000007-uKKrzikI, High: becomes a real test with roadmap Item 10
  // (RM-000011-sJpO9KMY).
  it.todo("cttc BUG-000007: Edit Gateway overwrites the working key before the new one is proven");
});

describe("br-SUMP-000008-sJpO9KMY", () => {
  // BUG-000008-uKKrzikI, High: becomes a real test with roadmap Item 17
  // (RM-000018-sJpO9KMY).
  it.todo("cttc BUG-000008: Orphan cleanup can kill an unrelated process");
  // BUG-000012-uKKrzikI, Medium: becomes a real test with roadmap Item 16, Item 17
  // (RM-000017-sJpO9KMY, RM-000018-sJpO9KMY).
  it.todo(
    "cttc BUG-000012: Switching to a known remote gateway collides with the local gateway's port",
  );
});
