import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript build script, without type declarations.
import { COLORED, generated } from "../../../../build/icons.js";
import { Icon } from "../Icon.js";
import { ICONS } from "../icons.generated.js";

// br-STYLE-000001-sJpO9KMY (REQ-000019-sJpO9KMY): the icons, clean and
// drawn in the text color.

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(DIR).filter((f) => f.endsWith(".svg"));
const svgOf = (f: string) => readFileSync(path.join(DIR, f), "utf8");

describe("br-STYLE-000001-sJpO9KMY: the icon set", () => {
  it("has the correlator icons under their decided names, and cttc's", () => {
    const names = Object.keys(ICONS);
    for (const n of [
      "sump",
      "data-stream",
      "stream",
      "project",
      "track",
      "recordind",
      "correlator",
      "correlator-app",
    ]) {
      expect(names).toContain(n);
    }
    for (const n of [
      "new",
      "edit",
      "remove",
      "secure-storage",
      "events",
      "analysis",
      "history",
      "settings",
      "appearance",
    ]) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain("gateway");
  });

  it("says where each icon came from", () => {
    const sources = JSON.parse(readFileSync(path.join(DIR, "sources.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(Object.keys(sources).sort()).toEqual(files.map((f) => f.replace(/\.svg$/, "")).sort());
  });

  it.each(files)("%s is clean", (file) => {
    const svg = svgOf(file);
    const name = file.replace(/\.svg$/, "");
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toMatch(/<svg [^>]*viewBox="/);
    expect(svg).not.toMatch(/<svg [^>]*\s(width|height)="/);
    expect(svg).not.toMatch(/<\?xml|<!DOCTYPE|<!--|<metadata|inkscape:|sodipodi:/i);
    expect(svg).not.toMatch(
      /<script|<foreignObject|\son[a-z]+=|href="(https?:|data:|javascript:)/i,
    );
    if (!(COLORED as Set<string>).has(name)) {
      expect(svg).not.toMatch(/(fill|stroke|stop-color)\s*[=:]\s*"?(?!currentColor|none)#|rgb\(/i);
      expect(svg).toContain('fill="currentColor"');
    }
  });

  it("strips the hard-coded fill of recordind.svg", () => {
    expect(svgOf("recordind.svg")).not.toContain("#060606");
  });

  it("generates icons.generated.ts in step with the .svg files", () => {
    expect(readFileSync(path.join(DIR, "icons.generated.ts"), "utf8")).toBe(generated());
  });
});

describe("REQ-000019-sJpO9KMY: <Icon>", () => {
  it("is decorative by default", () => {
    const html = renderToStaticMarkup(createElement(Icon, { name: "sump" }));
    expect(html).toMatch(/^<span class="icon" aria-hidden="true"><svg /);
  });

  it("is announced with its label when it has one", () => {
    const html = renderToStaticMarkup(
      createElement(Icon, { name: "history", label: "History", className: "big" }),
    );
    expect(html).toContain('class="icon big" role="img" aria-label="History"');
    expect(html).not.toContain('<svg aria-hidden="true"');
    expect(html.match(/aria-hidden/g)).toBeNull();
  });
});
