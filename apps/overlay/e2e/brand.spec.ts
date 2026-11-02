import { expect, test } from "@playwright/test";

for (const entry of [
  "/overlay/index.html",
  "/overlay/scene.html?scene=thinking",
  "/overlay/face-sheet.html",
  "/control/",
]) {
  test(`the local brand icon loads under the strict policy on ${entry}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const response = await page.goto(entry);
    expect(response?.headers()["content-security-policy"]).toContain("img-src 'self' data:");
    const icon = page.locator('link[rel="icon"]');
    await expect(icon).toHaveAttribute("type", "image/svg+xml");
    const url = await icon.evaluate((node) => (node as HTMLLinkElement).href);
    expect(new URL(url).pathname).toMatch(/\/favicon\.svg$/);
    const fetched = await page.request.get(url);
    expect(fetched.ok()).toBe(true);
    expect(fetched.headers()["content-type"]).toContain("image/svg+xml");
    expect(await fetched.text()).toContain('viewBox="0 0 512 512"');
    if (entry === "/control/") {
      await expect(page.getByRole("heading", { name: "Spokesmob", exact: true })).toBeVisible();
      await expect(page.locator(".brand-mark")).toHaveJSProperty("complete", true);
      expect(
        await page
          .locator(".brand-mark")
          .evaluate((node) => (node as HTMLImageElement).naturalWidth),
      ).toBeGreaterThan(0);
      expect((await page.locator(".brand-mark").boundingBox())?.width).toBe(46);
      const axes = await page
        .locator(".wordmark")
        .evaluate((node) => getComputedStyle(node).fontVariationSettings);
      expect(axes).toContain('"INFM" 70');
      expect(axes).toContain('"BNCE" 25');
    }
    expect(errors).toEqual([]);
  });
}
