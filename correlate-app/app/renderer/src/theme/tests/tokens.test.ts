import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// br-STYLE-000001-sJpO9KMY (REQ-000018-sJpO9KMY Requirements 1 and 2): the
// tokens are cttc's, value for value, light and dark.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKENS = path.join(HERE, "../tokens.css");
const REFERENCE = path.join(HERE, "../cttc-tokens.reference.css");
/** cttc's own file, when cttc is checked out next to this repository. */
const CTTC = path.resolve(HERE, "../../../../../../../cttc/app/renderer/style.css");

/** Custom properties of the light `:root` block and of the dark one. */
function tokens(css: string): { light: Map<string, string>; dark: Map<string, string> } {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const split = code.indexOf("@media (prefers-color-scheme: dark)");
  const read = (part: string) => {
    const found = new Map<string, string>();
    for (const m of part.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      found.set(m[1] as string, (m[2] as string).trim().replace(/\s+/g, " "));
    }
    return found;
  };
  if (split === -1) return { light: read(code), dark: new Map() };
  const rest = code.slice(split);
  const end = rest.indexOf("\n}\n");
  return {
    light: read(code.slice(0, split)),
    dark: read(end === -1 ? rest : rest.slice(0, end + 2)),
  };
}

describe("br-STYLE-000001-sJpO9KMY: cttc's design tokens", () => {
  const ours = tokens(readFileSync(TOKENS, "utf8"));
  const cttc = tokens(readFileSync(REFERENCE, "utf8"));

  it("has every cttc token, light and dark, with the same value and nothing more", () => {
    expect(Object.fromEntries(ours.light)).toEqual(Object.fromEntries(cttc.light));
    expect(Object.fromEntries(ours.dark)).toEqual(Object.fromEntries(cttc.dark));
  });

  it("has the tokens the roadmap names", () => {
    const names = [...ours.light.keys()];
    for (const prefix of ["--surface-", "--text-", "--series-", "--radius-", "--shadow-"]) {
      expect(names.some((n) => n.startsWith(prefix))).toBe(true);
    }
    for (const name of [
      "--accent",
      "--critical",
      "--warning",
      "--hl-color",
      "--live-track-color",
    ]) {
      expect(names).toContain(name);
    }
    expect(names.filter((n) => n.startsWith("--series-"))).toHaveLength(8);
    expect(ours.dark.size).toBeGreaterThan(20);
  });

  it("uses cttc's body type", () => {
    // Biome lays the shorthand out on several lines; the value is cttc's.
    const css = readFileSync(TOKENS, "utf8").replace(/\s+/g, " ").replace(/ \/ /g, "/");
    expect(css).toContain('font: 13px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif;');
    expect(css).toContain("-webkit-font-smoothing: antialiased;");
  });

  it("would catch a changed, missing or extra token", () => {
    const changed = tokens(
      readFileSync(TOKENS, "utf8").replace("--accent: #2a78d6", "--accent: #2a78d7"),
    );
    expect(Object.fromEntries(changed.light)).not.toEqual(Object.fromEntries(cttc.light));
    const extra = tokens(`:root { --extra: 1px; }\n${readFileSync(TOKENS, "utf8")}`);
    expect(Object.fromEntries(extra.light)).not.toEqual(Object.fromEntries(cttc.light));
    const missing = tokens(readFileSync(TOKENS, "utf8").replace("--warning: #fab219;", ""));
    expect(Object.fromEntries(missing.light)).not.toEqual(Object.fromEntries(cttc.light));
  });

  it.runIf(existsSync(CTTC))("still matches cttc's own file, where cttc is checked out", () => {
    const reference = readFileSync(REFERENCE, "utf8").split("\n").slice(3).join("\n");
    expect(readFileSync(CTTC, "utf8").startsWith(reference)).toBe(true);
  });
});
