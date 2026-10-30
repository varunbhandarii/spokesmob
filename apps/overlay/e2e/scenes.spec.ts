import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { CAPTURE_AT, SCENES } from "../src/view/scenes.js";

for (const layout of ["wide", "stage", "compact"])
  for (const scene of SCENES)
    test(`${layout} / ${scene}`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return url.hostname === "127.0.0.1" ? route.continue() : route.abort();
      });
      const response = await page.goto(`/overlay/scene.html?scene=${scene}&layout=${layout}`);
      expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
      await page.waitForFunction(() => !!window.scene);
      await page.evaluate((at) => window.scene.seek(at), CAPTURE_AT[scene]);
      // Let the advertised hold expire without a started/reveal event.
      if (scene === "preview") await page.waitForTimeout(1100);
      await expect(page.locator("#overlay")).toHaveAttribute("data-layout", layout);
      const hidden = [
        "listening",
        "thinking",
        "preview",
        "veto",
        "muted",
        "asleep",
        "hype",
      ].includes(scene);
      if (hidden) await expect(page.locator(".caption")).toBeHidden();
      else
        await expect(page.locator(".caption")).toHaveText(
          scene === "dissent" && layout === "compact"
            ? "Most of chat wants Gary. · 18% say Some prefer Milo."
            : "Most of chat wants Gary.",
        );
      if (scene === "veto")
        await expect(page.locator("#overlay")).toHaveAttribute("data-pose", "idle");
      await page.screenshot({ path: info.outputPath(`${layout}-${scene}.png`) });
      if (scene === "speaking")
        await page.screenshot({ path: resolve(`test-results/layout-${layout}.png`) });
      expect(errors).toEqual([]);
    });

test("face sheet contains every mood-mouth pair and every pose", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/overlay/face-sheet.html");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#mood-grid svg")).toHaveCount(35);
  await expect(page.locator("#pose-grid svg")).toHaveCount(9);
  await page.screenshot({ path: info.outputPath("face-sheet.png"), fullPage: true });
  await page.screenshot({ path: resolve("test-results/face-sheet.png"), fullPage: true });
  expect(errors).toEqual([]);
});
