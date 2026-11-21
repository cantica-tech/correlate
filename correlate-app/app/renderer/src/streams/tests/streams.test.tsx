/**
 * The data-stream picker (REQ-000025-sJpO9KMY Requirement 4): the checklist,
 * what submitting sends, the Sump's errors in its own words, and
 * `streams.css` held to cttc's rules.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bare, cssBlocks, cttcRules } from "../../testing/cttcCss.js";
import { sayError, type Targets } from "../api.js";
import { followedFrom, initialChecked, keyOf, TargetList } from "../TargetList.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const targets: Targets = {
  containers: [
    { id: "1", name: "web", image: "nginx:alpine" },
    { id: "2", name: "db", image: "postgres:17" },
  ],
  services: [{ name: "api", replicas: "2/2" }],
  followed: { containers: ["web", "gone"], services: ["api"] },
};

describe("br-STREAM-000002-sJpO9KMY: the checklist", () => {
  it("starts with what is followed and still there", () => {
    expect([...initialChecked(targets)].sort()).toEqual(["container:web", "service:api"]);
  });

  it("sends exactly what is checked among what is there, gone ones left out as cttc", () => {
    const checked = new Set([
      keyOf("container", "db"),
      keyOf("container", "gone"),
      keyOf("service", "api"),
    ]);
    expect(followedFrom(targets, checked)).toEqual({ containers: ["db"], services: ["api"] });
    expect(followedFrom(targets, new Set())).toEqual({ containers: [], services: [] });
  });

  it("is cttc's markup: groups, ✔ marks, images, and a gone target disabled and marked", () => {
    const out = renderToStaticMarkup(
      <TargetList targets={targets} checked={initialChecked(targets)} onChange={() => {}} />,
    );
    expect(out).toMatch(
      /^<div id="docker-targets"><div class="group" title="Click to select\/deselect all of this group" role="button" tabindex="0">Swarm services \(docker service logs\)<\/div>/,
    );
    expect(out).toContain(
      '<label><input type="checkbox" data-type="container" checked="" value="web"/><span class="mark">✔</span> web <span class="tdoc">nginx:alpine</span></label>',
    );
    expect(out).toContain('<span class="mark"></span> db <span class="tdoc">postgres:17</span>');
    expect(out).toContain(
      '<label class="unavailable"><input type="checkbox" data-type="container" disabled="" readOnly="" checked="" value="gone"/><span class="mark">🚫</span> gone <span class="tdoc">no longer available</span></label>',
    );
    expect(out.indexOf("Swarm services")).toBeLessThan(out.indexOf("Containers (docker logs)"));
  });

  it("has no services group off a Swarm manager, and says when nothing runs", () => {
    const plain = { ...targets, services: null, followed: { containers: [], services: [] } };
    expect(
      renderToStaticMarkup(<TargetList targets={plain} checked={new Set()} onChange={() => {}} />),
    ).not.toContain("Swarm services");
    const empty = { containers: [], services: null, followed: { containers: [], services: [] } };
    expect(
      renderToStaticMarkup(<TargetList targets={empty} checked={new Set()} onChange={() => {}} />),
    ).toContain("Nothing is running there.");
  });
});

describe("REQ-000025-sJpO9KMY: the Sump's errors", () => {
  it("says the Sump's own detail when it gave one", () => {
    expect(
      sayError({
        kind: "http",
        status: 502,
        message: "HTTP 502",
        detail: { detail: "Docker on ops@lab: ssh connect failed: Authentication failed." },
      }),
    ).toBe("Docker on ops@lab: ssh connect failed: Authentication failed.");
    expect(sayError({ kind: "network", message: "no answer" })).toBe("no answer");
  });
});

describe("br-STYLE-000001-sJpO9KMY: streams.css is cttc's", () => {
  const ours = readFileSync(path.join(here, "../streams.css"), "utf8");
  const blocks = cssBlocks(ours);

  it("is made of cttc blocks only", () => {
    expect(bare(blocks.map((b) => b.body).join(""))).toBe(bare(ours.slice(ours.indexOf("*/") + 2)));
    expect(blocks.every((b) => b.from)).toBe(true);
  });

  it.each(blocks.map((b) => [`${b.from}-${b.to}`, b] as const))(
    "block %s is cttc's lines",
    (_n, block) => {
      expect(bare(block.body)).toBe(cttcRules(block.from as number, block.to as number));
    },
  );
});
