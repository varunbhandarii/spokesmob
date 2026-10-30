import { expect, test } from "@playwright/test";

test("name batches are bounded, cited names gather on started, and clear wipes the canvas", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/overlay/scene.html?scene=listening&layout=stage");
  await page.waitForFunction(() => !!window.scene);
  await page.evaluate(() => {
    window.scene.seek(200);
    for (let batch = 0; batch < 2; batch++)
      window.scene.message({
        type: "particles",
        names: Array.from({ length: 200 }, (_, i) => `SyntheticViewer${String(batch * 200 + i)}`),
      });
  });
  await expect(page.locator(".particle-canvas")).toHaveAttribute("data-count", "400");
  await page.screenshot({ path: info.outputPath("stage-particles.png") });
  await page.evaluate(() => window.scene.message({ type: "particles_clear" }));
  await expect(page.locator(".particle-canvas")).toHaveAttribute("data-count", "0");
  const blank = await page.locator(".particle-canvas").evaluate((element) => {
    const data = (element as HTMLCanvasElement)
      .getContext("2d")
      ?.getImageData(0, 0, 1920, 1080).data;
    return !!data && !data.some((value) => value !== 0);
  });
  expect(blank).toBe(true);
  await page.evaluate(() => window.scene.seek(1800));
  // This page's listening sequence has no playback report: no local timer may gather it.
  await expect(page.locator(".particle-canvas")).toHaveAttribute("data-count", "3");
  await page.goto("/overlay/scene.html?scene=speaking&layout=wide");
  await page.waitForFunction(() => !!window.scene);
  await page.evaluate(() => window.scene.seek(1800));
  await expect(page.locator(".particle-canvas")).toHaveAttribute("data-count", "0", {
    timeout: 3000,
  });
  expect(errors).toEqual([]);
});
