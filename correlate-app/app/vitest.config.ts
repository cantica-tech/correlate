/** Vitest configuration: unit tests live in `tests/` folders next to the code they test. */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["renderer/src/**/tests/*.test.ts"],
  },
});
