/**
 * The one stylesheet of cttc's rules (br-STYLE-000001-sJpO9KMY): every ported
 * block, in cttc's own order, so rules of equal specificity win as in cttc.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a plain JavaScript build script, typed by JSDoc
import { blocks, generated, OUTPUT } from "../../../../build/cttc-css.js";

describe("br-STYLE-000001-sJpO9KMY: cttc.generated.css", () => {
  it("is in step with the ported stylesheets (npm run css)", () => {
    expect(readFileSync(OUTPUT, "utf8")).toBe(generated());
  });

  it("holds every block in cttc's line order, a block of ours after the one it follows", () => {
    const all = blocks() as { from?: number; head: string; file: string }[];
    const lines = all.filter((b) => b.from !== undefined).map((b) => b.from as number);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(all.length).toBeGreaterThan(25);
    const ours = all.findIndex((b) => b.head.startsWith("ours: cttc placed a head's controls"));
    expect(all[ours - 1]?.head).toBe("cttc style.css:1284-1284");
  });

  it("puts cttc's button:hover after the sidebar's .ab-group button, as cttc's file does", () => {
    const text = generated();
    expect(text.search(/^\.ab-group button \{/m)).toBeLessThan(text.search(/^button:hover \{/m));
    expect(text.search(/^button:hover \{/m)).toBeGreaterThan(0);
  });
});
