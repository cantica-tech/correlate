/**
 * The component primitives (REQ-000020-sJpO9KMY Requirement 1): their markup
 * is cttc's, so cttc's rules in `components.css` style them; and that CSS is
 * cttc's own, block for block.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bare, cssBlocks, cttcRules } from "../../testing/cttcCss.js";
import { Button } from "../Button.js";
import { Dialog } from "../Dialog.js";
import { Panel } from "../Panel.js";
import { SegControl } from "../SegControl.js";
import { Switch } from "../Switch.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const noop = () => {};

describe("br-STYLE-000001-sJpO9KMY: Button", () => {
  it.each([
    ["default", '<button type="button">Close</button>'],
    ["primary", '<button type="button" class="primary">Close</button>'],
    ["danger", '<button type="button" class="btn-danger">Close</button>'],
  ] as const)("%s is cttc's markup", (kind, markup) => {
    expect(html(<Button kind={kind}>Close</Button>)).toBe(markup);
  });

  it("fetch carries cttc's fetch icon before its label", () => {
    const out = html(<Button kind="fetch">Fetch</Button>);
    expect(out).toMatch(
      /^<button type="button" class="btn-fetch"><span class="icon btn-fetch-icon"/,
    );
    expect(out).toMatch(/<\/span>Fetch<\/button>$/);
  });

  it("keeps a submit type, a class of its own and disabled", () => {
    expect(
      html(
        <Button kind="primary" type="submit" className="wide" disabled>
          Save
        </Button>,
      ),
    ).toBe('<button type="submit" class="primary wide" disabled="">Save</button>');
  });
});

describe("br-STYLE-000001-sJpO9KMY: Dialog", () => {
  it("is a native dialog named by its h2, its buttons in .dlg-actions", () => {
    const out = html(
      <Dialog
        open={false}
        onClose={noop}
        title="Remove Sump"
        id="dlg-remove"
        actions={<Button>Close</Button>}
      >
        <p className="dlg-intro muted">Permanently forgets it.</p>
      </Dialog>,
    );
    expect(out).toMatch(
      /^<dialog id="dlg-remove" aria-labelledby="(dlg-title-\d+)"><h2 id="\1">Remove Sump<\/h2>/,
    );
    expect(out).toContain(
      '<p class="dlg-intro muted">Permanently forgets it.</p><div class="dlg-actions"><button type="button">Close</button></div></dialog>',
    );
  });

  it("has no .dlg-actions when it has no buttons", () => {
    expect(html(<Dialog open={false} onClose={noop} title="t" />)).not.toContain("dlg-actions");
  });
});

describe("br-STYLE-000001-sJpO9KMY: SegControl", () => {
  it("shows every option, the chosen one active and pressed", () => {
    const out = html(
      <SegControl
        label="Mode"
        value="dark"
        onChange={noop}
        options={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
          { value: "system", label: "System" },
        ]}
      />,
    );
    expect(out).toBe(
      '<span class="btn-group seg-control" role="group" aria-label="Mode">' +
        '<button type="button" aria-pressed="false">Light</button>' +
        '<button type="button" data-active="true" aria-pressed="true">Dark</button>' +
        '<button type="button" aria-pressed="false">System</button></span>',
    );
  });

  it("draws an option's icon in .seg-icon", () => {
    const out = html(
      <SegControl
        label="View"
        value="a"
        onChange={noop}
        options={[{ value: "a", label: "A", icon: "track" }]}
      />,
    );
    expect(out).toContain('<span class="icon seg-icon" aria-hidden="true">');
  });
});

describe("br-STYLE-000001-sJpO9KMY: Switch", () => {
  it("is cttc's markup around a real checkbox with the switch role", () => {
    expect(
      html(
        <Switch checked id="status-bar" onChange={noop}>
          Show status bar
        </Switch>,
      ),
    ).toBe(
      '<label class="ctl switch-row"><span class="switch">' +
        '<input id="status-bar" type="checkbox" role="switch" aria-checked="true" checked=""/>' +
        '<span class="switch-track"><span class="switch-thumb"></span></span></span>' +
        "<span>Show status bar</span></label>",
    );
  });
});

describe("br-STYLE-000001-sJpO9KMY: Panel", () => {
  it("is a .panel with a centered title and right-hand controls", () => {
    expect(
      html(
        <Panel title="Logs" controls={<Button>x</Button>}>
          rows
        </Panel>,
      ),
    ).toBe(
      '<section class="panel"><div class="panel-head"><div class="panel-head-top">' +
        '<span class="panel-head-title">Logs</span>' +
        '<div class="panel-head-right"><button type="button">x</button></div></div></div>' +
        '<div class="panel-body">rows</div></section>',
    );
  });

  it("has no head without a title or controls, and takes a body class", () => {
    expect(html(<Panel bodyClassName="plain">x</Panel>)).toBe(
      '<section class="panel"><div class="plain">x</div></section>',
    );
  });
});

describe("br-STYLE-000001-sJpO9KMY: components.css is cttc's", () => {
  const ours = readFileSync(path.join(here, "../components.css"), "utf8");
  const blocks = cssBlocks(ours);

  it("is made of cttc blocks, and ours each with a reason", () => {
    expect(blocks.length).toBeGreaterThan(10);
    expect(bare(blocks.map((b) => b.body).join(""))).toBe(bare(ours.slice(ours.indexOf("*/") + 2)));
  });

  it.each(blocks.filter((b) => b.from).map((b) => [`${b.from}-${b.to}`, b] as const))(
    "block %s is cttc's lines, rule for rule",
    (_name, block) => {
      expect(bare(block.body)).toBe(cttcRules(block.from as number, block.to as number));
    },
  );

  it("lists every block of ours with its reason", () => {
    const own = blocks.filter((b) => !b.from).map((b) => b.head);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/ours: cttc placed a head's controls by panel id/);
  });
});
