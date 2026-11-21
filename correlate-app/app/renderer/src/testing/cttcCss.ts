/**
 * Holding our CSS to cttc's (br-STYLE-000001-sJpO9KMY): a stylesheet of ours
 * is made of blocks, each headed `cttc style.css:A-B` (cttc's lines A to B,
 * rule for rule) or `ours: <reason>`. These helpers split it and compare.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** cttc's `style.css` at d8a444b, verbatim, by line. */
export const CTTC_LINES = readFileSync(
  path.join(here, "../../../tests/parity/cttc/style.reference.css"),
  "utf8",
).split("\n");

/** Comments out, all whitespace out: what is left is the rules themselves. */
export const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");

/** One block of a stylesheet of ours. */
export interface CssBlock {
  /** `cttc style.css:A-B`, or `ours: <reason>`. */
  head: string;
  /** cttc's lines, for a cttc block. */
  from?: number;
  to?: number;
  body: string;
}

/** Split a stylesheet of ours into its blocks. */
export function cssBlocks(css: string): CssBlock[] {
  return [
    ...css.matchAll(
      /\/\* (cttc style\.css:(\d+)-(\d+)|ours:[\s\S]*?) \*\/([\s\S]*?)(?=\/\* (?:cttc style\.css:|ours:)|$)/g,
    ),
  ].map((m) => ({
    head: m[1] ?? "",
    from: m[2] ? Number(m[2]) : undefined,
    to: m[3] ? Number(m[3]) : undefined,
    body: m[4] ?? "",
  }));
}

/** cttc's lines `from` to `to`, rules only. */
export const cttcRules = (from: number, to: number) =>
  bare(CTTC_LINES.slice(from - 1, to).join("\n"));
