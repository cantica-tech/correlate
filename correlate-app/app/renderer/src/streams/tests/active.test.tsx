/**
 * The window's active stream and its pill (REQ-000027-sJpO9KMY Requirements 3
 * and 4), and the Remove dialog's markup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShellBridge } from "../../shell/bridge.js";
import { healActive, streamPillState, streamRows, streamWhere } from "../active.js";
import type { Stream } from "../api.js";
import { RemoveDialog } from "../RemoveDialog.js";
import { StreamPill } from "../StreamPill.js";

const self: Stream = { id: "self", kind: "self", label: "This Sump's host", following: 2 };
const lab: Stream = { id: "ssh:ops@lab:22", kind: "ssh", label: "ops@lab", following: 0 };

describe("br-STREAM-000001-sJpO9KMY: the active stream heals", () => {
  it("stays on a stream that is there", () => {
    expect(healActive(lab.id, [self, lab], "self")).toBe(lab.id);
  });

  it("goes to the picker's last stream, then self, then the first, then none", () => {
    expect(healActive("ssh:gone:22", [self, lab], lab.id)).toBe(lab.id);
    expect(healActive(null, [self, lab], "ssh:gone:22")).toBe("self");
    expect(healActive(null, [lab], null)).toBe(lab.id);
    expect(healActive("self", [], null)).toBeNull();
  });
});

describe("REQ-000027-sJpO9KMY: the data-stream pill", () => {
  it.each([
    [self, "up"],
    [{ ...self, paused: true }, "down"],
    [lab, "checking"],
    [undefined, "checking"],
  ] as const)("shows %j as %s", (stream, state) => {
    expect(streamPillState(stream)).toBe(state);
  });

  it("says where a stream is and its status", () => {
    expect(streamWhere(self)).toBe("the Sump's own host");
    expect(streamWhere(lab)).toBe("ops@lab:22");
    expect(streamRows({ ...self, paused: true })).toEqual([
      ["Data stream", "This Sump's host"],
      ["Kind", "the Sump's host"],
      ["Following", "2"],
      ["Collecting", "paused"],
    ]);
  });

  it("is cttc's Docker host pill markup", () => {
    const out = renderToStaticMarkup(<StreamPill bridge={{} as ShellBridge} onAction={() => {}} />);
    expect(out).toMatch(
      /^<div id="docker-host-status" class="server-status" data-state="checking"><button id="docker-host-status-btn" type="button" class="server-status-btn" aria-label="No data stream"/,
    );
    expect(out).toContain(
      '<span class="server-status-dot"></span><span class="icon" aria-hidden="true"><svg class="server-status-icon" ',
    );
  });
});

describe("br-STREAM-000004-sJpO9KMY: the Remove dialog", () => {
  it("is cttc's #dlg-remove-daemon, Delete disabled until a stream is picked", () => {
    const out = renderToStaticMarkup(
      <RemoveDialog bridge={{} as ShellBridge} open={false} onClose={() => {}} />,
    );
    expect(out).toMatch(
      /^<dialog id="dlg-remove-daemon" aria-labelledby="dlg-title-\d+"><h2 id="dlg-title-\d+">Remove Data Stream<\/h2>/,
    );
    expect(out).toContain(
      '<select id="remove-daemon-select"><option value="" selected="">— pick a data stream to remove —</option></select>',
    );
    expect(out).toContain(
      '<button type="button" class="btn-danger" id="dlg-remove-daemon-delete" disabled=""',
    );
  });
});
