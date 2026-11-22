/**
 * Promote… (REQ-000052-sJpO9KMY step 4, br-FED-000004-sJpO9KMY): a promoted
 * stream says "via <secondary>", Promote offers only SSH streams not yet
 * promoted, and its answer is said for people.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SecondaryInfo, ShellBridge } from "../../shell/bridge.js";
import { secondaryLabel, streamRows, streamWhere } from "../active.js";
import type { Stream } from "../api.js";
import { PromoteDialog, promotable, promoteText } from "../PromoteDialog.js";

const secondary: SecondaryInfo = {
  host: "lab",
  ssh_port: 22,
  ssh_user: "ops",
  sump_port: 8775,
  owner: "olivier",
  parent_user: "parent-sump",
  promoted_at: 1_795_000_000_000,
};
const self: Stream = { id: "self", kind: "self", label: "This Sump's host", following: 2 };
const lab: Stream = { id: "ssh:ops@lab:22", kind: "ssh", label: "ops@lab", following: 1 };
const promoted: Stream = { ...lab, secondary };

describe("br-FED-000004-sJpO9KMY: a promoted stream shows its secondary", () => {
  it("says it is collected via the secondary", () => {
    expect(streamWhere(promoted)).toBe("ops@lab:22 via lab (secondary)");
    expect(streamWhere(lab)).toBe("ops@lab:22");
    expect(secondaryLabel(promoted)).toBe("lab (secondary)");
    expect(streamRows(promoted)).toContainEqual(["Collecting", "by lab (secondary)"]);
    expect(streamRows(lab)).toContainEqual(["Collecting", "yes"]);
  });
});

describe("br-FED-000001-sJpO9KMY: the Promote dialog", () => {
  it("offers SSH streams not yet promoted", () => {
    expect(promotable([self, lab, { ...promoted, id: "ssh:ops@other:22" }])).toEqual([lab]);
  });

  it("says the promotion, and whether the secondary joined your Sumps", () => {
    expect(
      promoteText({
        ok: true,
        secondary,
        catalog: { ok: true, id: "s-1", name: "lab (secondary)" },
      }),
    ).toBe('Promoted: lab (secondary) collects it now, and is in your Sumps as "lab (secondary)"');
    expect(
      promoteText({
        ok: true,
        secondary,
        catalog: { ok: false, message: "All configured authentication methods failed" },
      }),
    ).toBe(
      "Promoted: lab (secondary) collects it now; not added to your Sumps (All configured authentication methods failed)",
    );
    expect(promoteText({ ok: false, message: "only the Sump's owner can promote" })).toBe(
      "only the Sump's owner can promote",
    );
  });

  it("is a dialog with Promote disabled until a stream is picked", () => {
    const out = renderToStaticMarkup(
      <PromoteDialog bridge={{} as ShellBridge} open={false} onClose={() => {}} />,
    );
    expect(out).toMatch(/^<dialog id="dlg-promote"/);
    expect(out).toContain('<select id="promote-stream"></select>');
    expect(out).toMatch(/id="dlg-promote-ok"[^>]*disabled=""/);
  });
});
