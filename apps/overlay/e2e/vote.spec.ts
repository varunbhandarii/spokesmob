import { expect, test } from "@playwright/test";

test("vote labels render as text, bars update and the server end clears the plate", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", () => errors.push("script error"));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("console error");
  });
  await page.goto("/overlay/scene.html?scene=listening&layout=stage");
  await page.waitForFunction(() => !!window.scene);
  await page.evaluate(() => {
    window.scene.seek(100);
    window.scene.message({
      type: "event",
      kind: "vote_begin",
      choices: ["<b>gary</b>", "milo"],
      durationS: 30,
    });
    window.scene.message({ type: "event", kind: "vote_update", counts: [3, 2] });
  });
  await expect(page.locator(".vote-plate")).toBeVisible();
  await expect(page.locator(".vote-title")).toHaveText("Vote: 1 <b>gary</b> · 2 milo");
  await expect(page.locator(".vote-title b")).toHaveCount(0);
  await expect(page.locator(".vote-counts")).toHaveText("3 / 2 · 30s");
  await expect(page.locator(".vote-bar").first()).toHaveAttribute(
    "style",
    "transform: scaleX(0.6);",
  );
  await page.evaluate(() => window.scene.message({ type: "event", kind: "vote_end" }));
  await expect(page.locator(".vote-plate")).toBeHidden();
  expect(errors).toEqual([]);
});
