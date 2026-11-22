/**
 * The status bar (REQ-000022-sJpO9KMY Requirements 2 to 4): the pill's
 * state from the lifecycle, the switcher's and Current Status's text, the
 * bar's markup, and `statusbar.css` held to cttc's rules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContextMenu } from "../../components/ContextMenu.js";
import type { ListedSump, ShellBridge, StateRecord } from "../../shell/bridge.js";
import { bare, cssBlocks, cttcRules } from "../../testing/cttcCss.js";
import { pillState, statusRows, whereIs } from "../pill.js";
import { StatusBar } from "../StatusBar.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const record = (id: string, state: StateRecord["state"]): [string, StateRecord] => [
  id,
  { id, state, since: "", reason: "" },
];
const local: ListedSump = {
  id: "local",
  name: "This computer",
  kind: "local",
  sumpPort: 8765,
  state: "active",
  current: true,
};
const remote: ListedSump = {
  id: "r1",
  name: "lab",
  kind: "remote",
  sshTarget: "ops@lab",
  sshPort: 2222,
  sumpPort: 8765,
  forwardUrl: "http://127.0.0.1:54123",
  state: "unreachable",
  current: false,
};

describe("REQ-000022-sJpO9KMY: the pill", () => {
  it.each([
    ["active", "up"],
    ["unreachable", "down"],
    ["retired", "down"],
    ["provisioning", "checking"],
  ] as const)("shows a Sump %s as %s", (state, shown) => {
    expect(pillState("a", new Map([record("a", state)]))).toBe(shown);
  });

  it("is checking while the window has no Sump, or its state is not known yet", () => {
    expect(pillState(undefined, new Map())).toBe("checking");
    expect(pillState("a", new Map())).toBe("checking");
  });

  it("says where each Sump is, as cttc's host:port", () => {
    expect(whereIs(local)).toBe("localhost:8765");
    expect(whereIs(remote)).toBe("ops@lab:2222");
    expect(whereIs({ ...remote, sshPort: 22 })).toBe("ops@lab");
  });

  it("gives Current Status's rows for a local and a remote Sump", () => {
    expect(statusRows(local)).toEqual([
      ["Connection", "local"],
      ["Sump", "This computer"],
      ["Address", "localhost:8765"],
    ]);
    expect(statusRows(remote)).toEqual([
      ["Connection", "SSH forward"],
      ["Sump", "lab"],
      null,
      ["ssh target", "ops@lab"],
      ["ssh port", "2222"],
      ["Sump port", "8765"],
      ["forwarded port", "localhost:54123"],
    ]);
    expect(statusRows({ ...remote, forwardUrl: undefined }).slice(-1)[0]).toEqual([
      "forwarded port",
      "not up",
    ]);
  });
});

describe("REQ-000022-sJpO9KMY: the bar's markup", () => {
  it("is cttc's: mode, mode divider, text, divider, pill, double divider, History", () => {
    const out = renderToStaticMarkup(<StatusBar bridge={{} as ShellBridge} />);
    // The mode icons, live shown (REQ-000033-sJpO9KMY), as cttc's index.html:286-288.
    expect(out).toMatch(
      /^<div id="app-status-bar" class="app-status-bar"><span id="status-bar-mode-live" class="toolbar-mode-icon" title="Live tracking">/,
    );
    expect(out).toMatch(
      /<span id="status-bar-mode-record" class="toolbar-mode-icon" title="[^"]*" hidden="" role="button" tabindex="-1">.*?<\/span><span class="toolbar-mode-divider"><\/span><span id="app-status-bar-text"><\/span><span class="status-bar-divider"><\/span><div id="server-status" class="server-status" data-state="checking">/,
    );
    expect(out).toContain(
      '<button id="server-status-btn" type="button" class="server-status-btn" aria-label="No Sump: being checked"',
    );
    expect(out).toContain(
      '<span class="server-status-dot"></span><span class="icon" aria-hidden="true"><svg class="server-status-icon" ',
    );
    expect(out).toContain('<span class="status-bar-divider status-bar-divider-double"></span>');
    expect(out).toContain(
      'id="status-bar-history-btn" class="status-bar-history-btn" title="History" aria-expanded="false">',
    );
  });

  it("draws cttc's context menu: entries with icons, separators, disabled ones", () => {
    const out = renderToStaticMarkup(
      <ContextMenu
        x={0}
        y={0}
        label="Sump"
        onClose={() => {}}
        entries={[
          { label: "New Sump…", icon: "new", disabled: true, onSelect: () => {} },
          "separator",
          { label: "Current Status", onSelect: () => {} },
        ]}
      />,
    );
    expect(out).toMatch(/^<div id="ctxmenu" role="menu" aria-label="Sump" tabindex="-1">/);
    expect(out).toContain(
      '<button type="button" role="menuitem" disabled=""><span class="icon ctxmenu-icon"',
    );
    expect(out).toContain('<div class="ctxmenu-sep" aria-hidden="true"></div>');
    expect(out).toContain(
      '<button type="button" role="menuitem"><span>Current Status</span></button>',
    );
  });
});

describe("br-STYLE-000001-sJpO9KMY: statusbar.css is cttc's", () => {
  const ours = readFileSync(path.join(here, "../statusbar.css"), "utf8");
  const blocks = cssBlocks(ours);

  it("is made of cttc blocks only", () => {
    expect(bare(blocks.map((b) => b.body).join(""))).toBe(bare(ours.slice(ours.indexOf("*/") + 2)));
    expect(blocks.every((b) => b.from)).toBe(true);
  });

  it.each(blocks.map((b) => [`${b.from}-${b.to}`, b] as const))(
    "block %s is cttc's lines, rule for rule",
    (_n, block) => {
      expect(bare(block.body)).toBe(cttcRules(block.from as number, block.to as number));
    },
  );
});
