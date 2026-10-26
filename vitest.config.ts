import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "apps/*/vitest.config.ts",
      "packages/*/vitest.config.ts",
      "tools/*/vitest.config.ts",
      "eval/vitest.config.ts",
    ],
  },
});
