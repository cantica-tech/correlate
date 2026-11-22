/**
 * The question before abandoning a recording (REQ-000039-sJpO9KMY
 * Requirement 2, br-REC-000001-sJpO9KMY): when it is asked, and what it says.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecordingState } from "../../shell/bridge.js";
import { AbandonDialog, needsAsking } from "../Abandon.js";

const state = (status: RecordingState["status"], stream = "self"): RecordingState => ({
  status,
  target: status === "idle" ? null : { sump: "local", stream, containers: [], host: false },
  segments: [],
  segmentStart: null,
});

describe("br-REC-000001-sJpO9KMY: asking before abandoning", () => {
  it("asks only while a recording is not idle, and only for what touches it", () => {
    expect(needsAsking(null)).toBe(false);
    expect(needsAsking(state("idle"))).toBe(false);
    for (const status of ["recording", "paused", "stopped"] as const)
      expect(needsAsking(state(status))).toBe(true);
    const ofOps = (r: RecordingState) => r.target?.stream === "ops";
    expect(needsAsking(state("paused", "self"), ofOps)).toBe(false);
    expect(needsAsking(state("paused", "ops"), ofOps)).toBe(true);
  });

  it("names the action and what would be lost, Cancel first and Abandon as danger", () => {
    const html = renderToStaticMarkup(
      <AbandonDialog
        asking={{ action: "Switching to Sump lab", status: "stopped" }}
        onCancel={() => {}}
        onAbandon={() => {}}
      />,
    );
    expect(html).toContain("Abandon the recording?");
    expect(html).toContain(
      "Switching to Sump lab will abandon the recording stopped but not saved: it has not been saved and will be discarded. Stop first to keep it.",
    );
    expect(html.indexOf("dlg-abandon-recording-cancel")).toBeLessThan(
      html.indexOf("dlg-abandon-recording-confirm"),
    );
    expect(html).toContain('class="btn-danger" id="dlg-abandon-recording-confirm"');
  });
});
