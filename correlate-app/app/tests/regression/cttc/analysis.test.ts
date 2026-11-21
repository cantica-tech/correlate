/**
 * Regression corpus of cttc's bugs: analysis view (ANLYS).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { describe, it } from "vitest";

describe("br-ANLYS-000001-sJpO9KMY", () => {
  // BUG-000014-uKKrzikI, High: becomes a real test with roadmap Item 43
  // (RM-000044-sJpO9KMY).
  it.todo("cttc BUG-000014: Snapshots mix live and loaded-file telemetry");
});

describe("br-ANLYS-000002-sJpO9KMY", () => {
  // BUG-000016-uKKrzikI, Medium: becomes a real test with roadmap Item 34
  // (RM-000035-sJpO9KMY).
  it.todo("cttc BUG-000016: 'now' label moves the analysis view to the present");
});

describe("br-ANLYS-000004-sJpO9KMY", () => {
  // BUG-000017-uKKrzikI, Medium: becomes a real test with roadmap Item 35
  // (RM-000036-sJpO9KMY).
  it.todo("cttc BUG-000017: Multi-file load centres on the union, not the active file");
  // BUG-000018-uKKrzikI, Low: becomes a real test with roadmap Item 35
  // (RM-000036-sJpO9KMY).
  it.todo("cttc BUG-000018: Re-opening or switching files does not use the 75% framing");
});

describe("br-ANLYS-000005-sJpO9KMY", () => {
  // BUG-000019-uKKrzikI, Medium: becomes a real test with roadmap Item 35
  // (RM-000036-sJpO9KMY).
  it.todo("cttc BUG-000019: Open-file dedup keys on basename only");
});
