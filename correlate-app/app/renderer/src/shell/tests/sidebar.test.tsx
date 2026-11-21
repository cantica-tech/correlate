/**
 * The sidebar (REQ-000021-sJpO9KMY Requirement 1): cttc's markup with the
 * sections decided in FEAT-000022-sJpO9KMY, and `shell.css` held to cttc's
 * rules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bare, cssBlocks, cttcRules } from "../../testing/cttcCss.js";
import type { SidebarLayout } from "../bridge.js";
import { railArrow, Sidebar } from "../Sidebar.js";
import { SECTIONS, SEPARATOR } from "../sections.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const noop = () => {};
const base: SidebarLayout = {
  dock: "left",
  lastDock: "left",
  width: 210,
  collapsed: false,
  expanded: { sump: true, projects: false, events: false },
};
const html = (layout: SidebarLayout, detached = false) =>
  renderToStaticMarkup(
    <Sidebar layout={layout} detached={detached} onChange={noop} onAction={noop} />,
  );

describe("br-STYLE-000001-sJpO9KMY: the sidebar", () => {
  it("has the decided sections and entries, in order", () => {
    expect(SECTIONS.map((s) => s.title)).toEqual(["Sump", "Projects", "Events"]);
    const labels = SECTIONS.map((s) => s.entries.map((e) => (e === SEPARATOR ? "—" : e.label)));
    expect(labels).toEqual([
      [
        "New Sump…",
        "Edit Sump…",
        "Uninstall Sump…",
        "—",
        "New Data Stream…",
        "Edit Data Streams…",
        "Close Data Streams",
        "Remove Data Stream…",
        "—",
      ],
      ["New Project…", "Open Project…", "Opened Data…", "—"],
      ["Create Event…", "Edit Events…", "—"],
    ]);
  });

  it("is cttc's markup, its width inline, an open section's body shown", () => {
    const out = html(base);
    expect(out).toMatch(/^<aside id="action-bar" data-collapsed="false" style="width:210px">/);
    expect(out).toContain(
      '<div class="ab-dock-controls"><button type="button" id="ab-collapse-toggle" class="ab-dock-btn"',
    );
    expect(out).toContain('data-dock-to="left" data-current="true" title="Dock left">◧</button>');
    expect(out).toContain(
      'data-dock-to="detached" data-current="false" title="Detach into its own window">⧉</button>',
    );
    expect(out).toContain(
      '<div class="ab-group" data-section="sump" data-expanded="true"><button type="button" class="ab-group-header" aria-expanded="true"><span class="icon ab-group-icon" aria-hidden="true">',
    );
    expect(out).toContain(
      '<span class="ab-group-title">Sump</span><span class="ab-chevron">▾</span></button><div class="ab-group-body">',
    );
    expect(out).toContain('<div class="ab-group-body" hidden="">');
    expect(out).toContain('<div class="ab-group ab-group-flat ab-group-bottom">');
  });

  it("disables what is not built yet, saying so, and leaves Preferences, About and Quit working", () => {
    const out = html(base);
    expect(out).toContain(
      '<button type="button" data-action="new-sump" disabled="" title="Provision a Sump here or on a host over SSH (Not available yet)">',
    );
    for (const a of ["preferences", "about", "quit"]) {
      expect(out).toMatch(new RegExp(`<button type="button" data-action="${a}">`));
    }
  });

  it("is a rail without its width when collapsed", () => {
    expect(html({ ...base, collapsed: true })).toMatch(
      /^<aside id="action-bar" data-collapsed="true">/,
    );
  });

  it("has Bring Back in place of the dock controls when detached", () => {
    const out = html({ ...base, dock: "detached" }, true);
    expect(out).toMatch(
      /^<aside id="action-bar" class="detached"><div class="ab-dock-controls"><button type="button" id="ab-redock" class="btn-flat" title="Bring back into the main window"><span class="icon" aria-hidden="true"><svg class="btn-flat-icon" /,
    );
    expect(out).not.toContain("ab-collapse-toggle");
  });

  it.each([
    ["left", false, "▸"],
    ["left", true, "◂"],
    ["right", false, "◂"],
    ["right", true, "▸"],
  ] as const)("shows cttc's rail arrow docked %s, collapsed %s: %s", (dock, collapsed, arrow) => {
    expect(railArrow({ ...base, dock, lastDock: dock, collapsed })).toBe(arrow);
  });
});

describe("br-STYLE-000001-sJpO9KMY: shell.css is cttc's", () => {
  const ours = readFileSync(path.join(here, "../shell.css"), "utf8");
  const blocks = cssBlocks(ours);

  it("is made of cttc blocks, and ours each with a reason", () => {
    expect(bare(blocks.map((b) => b.body).join(""))).toBe(bare(ours.slice(ours.indexOf("*/") + 2)));
  });

  it.each(blocks.filter((b) => b.from).map((b) => [`${b.from}-${b.to}`, b] as const))(
    "block %s is cttc's lines, rule for rule",
    (_name, block) => {
      expect(bare(block.body)).toBe(cttcRules(block.from as number, block.to as number));
    },
  );

  it("lists every block of ours with its reason", () => {
    expect(blocks.filter((b) => !b.from).map((b) => b.head)).toEqual([
      expect.stringMatching(/^ours: cttc's body is the flex column/),
    ]);
  });
});
