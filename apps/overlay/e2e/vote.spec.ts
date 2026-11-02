import { expect, test } from "@playwright/test";

for (const layout of ["wide", "stage", "compact"]) {
  test(`vote labels render as text, bars update and the server end clears the plate in ${layout}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", () => errors.push("script error"));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push("console error");
    });
    await page.goto(`/overlay/scene.html?scene=listening&layout=${layout}`);
    await page.waitForFunction(() => !!window.scene);
    await page.evaluate(() => {
      window.scene.seek(100);
      window.scene.message({
        type: "event",
        kind: "vote_begin",
        choices: ["<b>Gary</b>", "Milo"],
        durationS: 30,
      });
      window.scene.message({ type: "event", kind: "vote_update", counts: [6, 4] });
    });
    await expect(page.locator(".vote-plate")).toBeVisible();
    await expect(page.locator(".vote-title")).toHaveText("CHAT VOTE");
    await expect(page.locator(".vote-label")).toHaveText(["1 <b>Gary</b>", "2 Milo"]);
    await expect(page.locator(".vote-label b")).toHaveCount(0);
    await expect(page.locator(".vote-count")).toHaveText(["6", "4"]);
    await expect(page.locator(".vote-counts")).toHaveText("30");
    await expect(page.locator(".vote-bar").first()).toHaveAttribute(
      "style",
      "transform: scaleX(0.6);",
    );
    const fits = await page.locator(".vote-plate").evaluate((node) => {
      const box = node.getBoundingClientRect();
      const slot = node.parentElement?.getBoundingClientRect();
      return (
        !!slot && box.width <= slot.width + 1 && box.height <= slot.height + 1 && box.bottom <= 1080
      );
    });
    expect(fits).toBe(true);
    const question = await page.locator(".question").boundingBox();
    const card = await page.locator(".vote-plate").boundingBox();
    expect(question && card && question.y + question.height < card.y).toBeTruthy();
    await page.evaluate(() => window.scene.message({ type: "event", kind: "vote_end" }));
    await expect(page.locator(".vote-plate")).toBeHidden();
    expect(errors).toEqual([]);
  });
}
