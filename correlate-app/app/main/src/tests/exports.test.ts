import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as main from "../index.js";

// What main.cjs takes from the bundle must exist: a missing export only shows
// when Electron starts (it did once, in STEP-000051-sJpO9KMY).

const MAIN_CJS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../main.cjs");

describe("main.cjs and the main-process bundle", () => {
  it("finds every name it destructures from main/dist/main.cjs", () => {
    const source = readFileSync(MAIN_CJS, "utf8");
    const block = /const \{([^}]+)\} = require\("\.\/main\/dist\/main\.cjs"\)/.exec(source)?.[1];
    expect(block).toBeDefined();
    const names = (block as string)
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    expect(names.length).toBeGreaterThan(5);
    const missing = names.filter((name) => !(name in main));
    expect(missing).toEqual([]);
  });
});
