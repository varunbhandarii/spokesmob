import { expect, test } from "@playwright/test";
import { sceneLine } from "../src/view/scenes.js";

for (const layout of ["wide", "stage", "compact"]) {
  test(`fitted text and disclosure stay inside their zones in ${layout}`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`/overlay/scene.html?scene=dissent&layout=${layout}`);
    await page.waitForFunction(() => !!window.scene);
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scene.seek(4100);
    });
    await page.waitForTimeout(300);
    await expect(page.locator(".agreement")).toHaveText("71% of 312 voices");
    await expect(page.locator(".counter")).toBeHidden();
    await expect(page.locator(layout === "compact" ? ".compact-dissent" : ".dissent")).toHaveText(
      layout === "compact" ? "\u00b7 18% \u00b7 Some prefer Milo." : "18% \u00b7 Some prefer Milo.",
    );
    const geometry = await page.evaluate(() => {
      const selectors = [".question", ".agreement", ".caption", ".ai-badge"];
      if (document.querySelector("#overlay")?.getAttribute("data-layout") !== "compact")
        selectors.push(".dissent");
      return selectors.map((selector) => {
        const node = document.querySelector<HTMLElement>(selector);
        if (!node?.firstChild) throw new Error("Missing text plate");
        const box = node.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node);
        const ink = range.getBoundingClientRect();
        const slot = node.parentElement?.getBoundingClientRect();
        return {
          selector,
          fits: ink.top >= box.top - 1 && ink.bottom <= box.bottom + 1,
          slotFits: !!slot && box.width <= slot.width + 1 && box.height <= slot.height + 1,
        };
      });
    });
    expect(
      geometry.every((row) => row.fits && row.slotFits),
      JSON.stringify(geometry),
    ).toBe(true);
    if (layout === "compact") {
      const lines = await page.locator(".agreement").evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return range.getClientRects().length;
      });
      expect(lines).toBe(1);
    }
    const badge = await page.locator(".ai-badge").boundingBox();
    const face = await page.locator(".face-host").boundingBox();
    expect(badge && face && badge.y < face.y + face.height / 2).toBeTruthy();
    const question = await page.locator(".question").boundingBox();
    expect(question?.width).toBeLessThan(layout === "stage" ? 1000 : 700);
    if (layout === "stage") {
      await expect(page.locator(".channel-qr svg")).toBeVisible();
      await expect(page.locator(".channel-qr")).toHaveAttribute(
        "data-url",
        "https://twitch.tv/synthetic_channel",
      );
    }
    await page.screenshot({ path: info.outputPath(`text-${layout}.png`) });
    await page.evaluate(() => window.scene.message({ type: "stop", take: "all" }));
    await expect(page.locator(".agreement")).toBeHidden();
    await expect(page.locator(".counter")).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("preview shows only a bubble and production never renders harness labels", async ({
  page,
}) => {
  await page.goto("/overlay/scene.html?scene=preview&layout=wide");
  await page.waitForFunction(() => !!window.scene);
  await page.evaluate(() => window.scene.seek(700));
  await expect(page.locator(".preview-bubble")).toHaveText("\u2026");
  await expect(page.locator(".caption")).toBeHidden();
  await page.goto("/overlay/index.html");
  await expect(page.locator("#overlay")).toHaveAttribute("data-pose", "asleep");
  await expect(page.locator("body")).not.toContainText(/Temporary face|Synthetic scene/i);
});

test("long captions shrink to three lines and unrelated lines retain a question header", async ({
  page,
}) => {
  await page.goto("/overlay/scene.html?scene=speaking&layout=wide");
  await page.waitForFunction(() => !!window.scene);
  const text = Array(20).fill("Extraordinary").join(" ");
  await page.evaluate(
    ({ line, text }) => {
      window.scene.seek(1800);
      window.scene.message({ ...line, take: 99, text, answersQuestion: false });
      window.scene.message({ type: "prepare", take: 99, channel: "main", text });
      window.scene.message({ type: "play", take: 99, durationMs: 10000 });
      window.scene.playback({ type: "started", take: 99 });
    },
    { line: sceneLine, text },
  );
  await expect(page.locator(".caption-lead")).toHaveText("Meanwhile, chat says");
  await expect(page.locator(".question")).toHaveText("Name the cat?");
  const result = await page.locator(".caption").evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      size: parseFloat(style.fontSize),
      height: node.scrollHeight,
      limit: parseFloat(style.lineHeight) * 3 + 24,
    };
  });
  expect(result.size).toBeLessThan(48);
  expect(result.height).toBeLessThanOrEqual(result.limit + 1);
  await page.evaluate(() => window.scene.message({ type: "stop", take: "all" }));
  await expect(page.locator(".caption")).toBeHidden();
});
