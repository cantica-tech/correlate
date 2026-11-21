/**
 * Vitest configuration: unit tests live in `tests/` folders next to the code
 * they test; `tests/` at the top holds cross-cutting suites such as the cttc
 * bug corpus (`tests/regression/cttc/`).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["renderer/src/**/tests/*.test.ts", "tests/**/*.test.ts"],
  },
});
