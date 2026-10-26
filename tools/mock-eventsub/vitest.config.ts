import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    name: "mock-eventsub",
    environment: "node",
    include: ["src/**/*.unit.test.ts", "src/**/*.replay.test.ts"],
  },
});
