import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  outputDir: fileURLToPath(new URL("../../../test-results/visuals/", import.meta.url)),
  fullyParallel: false,
  workers: 1,
  timeout: 20000,
  reporter: "line",
  use: {
    browserName: "chromium",
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    baseURL: "http://127.0.0.1:4173",
    trace: "off",
    video: "off",
  },
  webServer: {
    command: "node --import tsx apps/overlay/e2e/server.ts",
    cwd: root,
    url: "http://127.0.0.1:4173/healthz",
    reuseExistingServer: false,
    timeout: 15000,
    stdout: "ignore",
  },
});
