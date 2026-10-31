import { expect, type Page, test } from "@playwright/test";
import { sceneLine, sceneState } from "../src/view/scenes.js";

async function scene(page: Page, name: string) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(`/overlay/scene.html?scene=${name}&layout=wide`);
  await page.waitForFunction(() => !!window.scene);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  return errors;
}
test("Round Ink follows audio amplitude, round vowels, dissent and the end envelope", async ({
  page,
}) => {
  const errors = await scene(page, "speaking");
  const root = page.locator("#overlay");
  await page.evaluate(() => {
    window.scene.audio(0);
    window.scene.seek(1800);
  });
  await expect(root).toHaveAttribute("data-mouth-openness", "0.000");
  await expect(page.locator(".caption")).toBeVisible();
  await page.evaluate(() => window.scene.audio(0.1));
  await expect
    .poll(async () => Number(await root.getAttribute("data-mouth-openness")))
    .toBeGreaterThan(0.75);
  const main = Number(await root.getAttribute("data-mouth-openness"));
  await expect(page.locator(".round-ink")).toHaveAttribute("data-mouth", "wide");
  await page.evaluate(() => window.scene.audio(0.05, 0.8));
  await expect(page.locator(".round-ink")).toHaveAttribute("data-mouth", "o");
  await page.evaluate(() => window.scene.audio(0));
  await expect(page.locator(".round-ink")).toHaveAttribute("data-mouth", "closed");
  await page.evaluate(() => window.scene.audio(0.1));
  await expect
    .poll(async () => Number(await root.getAttribute("data-mouth-openness")))
    .toBeGreaterThan(0.75);
  await page.evaluate((text) => {
    window.scene.message({ type: "prepare", take: 2, channel: "dissent", text });
    window.scene.message({ type: "play", take: 2, durationMs: 1500 });
    window.scene.playback({ type: "ended", take: 1 });
    window.scene.playback({ type: "started", take: 2 });
  }, sceneLine.dissent ?? "");
  await expect(root).toHaveAttribute("data-pose", "aside");
  await page.waitForTimeout(300);
  const aside = Number(await root.getAttribute("data-mouth-openness"));
  expect(aside).toBeCloseTo(main * 0.6, 1);
  await expect(page.locator(".dissent")).toHaveText("18% \u00b7 Some prefer Milo.");
  await page.evaluate(() => window.scene.playback({ type: "ended", take: 2 }));
  await expect(root).toHaveAttribute("data-pose", "settle");
  await page.waitForTimeout(300);
  await expect(root).toHaveAttribute("data-mouth-openness", "0.000");
  await expect(page.locator(".round-ink")).toHaveAttribute("data-mouth", "closed");
  expect(errors).toEqual([]);
});

test("the rig keeps preview private, follows particle gaze, and restores mood, hype and sleep", async ({
  page,
}, info) => {
  const errors = await scene(page, "listening");
  const root = page.locator("#overlay");
  await page.evaluate(() => window.scene.seek(200));
  await page.waitForTimeout(300);
  const gaze = await root.evaluate((node) => [
    Number(node.dataset.gazeX),
    Number(node.dataset.gazeY),
  ]);
  expect(gaze.some((value) => Math.abs(value) > 0.1)).toBe(true);
  expect(gaze.every((value) => value >= -1 && value <= 1)).toBe(true);
  const pupil = await page.locator(".ri-left .ri-eye-mood > g").getAttribute("transform");
  expect(pupil).not.toBe("translate(0 0) rotate(0) scale(1 1)");
  await page.evaluate(
    (state) => window.scene.message({ type: "state", ...state, step: "synthesizing" }),
    sceneState,
  );
  await expect(root).toHaveAttribute("data-pose", "thinking");
  await page.evaluate(
    ({ state, line }) => {
      window.scene.message({ type: "state", ...state, step: "preview" });
      window.scene.message({ ...line, take: 99 });
    },
    { state: sceneState, line: sceneLine },
  );
  await expect(root).toHaveAttribute("data-pose", "inhale");
  await expect(page.locator(".caption")).toBeHidden();
  await expect(page.locator(".preview-bubble")).toBeVisible();
  await page.evaluate(() => window.scene.message({ type: "reveal", take: 99 }));
  await expect(root).toHaveAttribute("data-pose", "reading");
  await expect(page.locator(".caption")).toHaveText(sceneLine.text);
  await page.evaluate(() => window.scene.message({ type: "veto", take: 99 }));
  await expect(root).toHaveAttribute("data-pose", "idle");
  await expect(page.locator(".caption")).toBeHidden();
  await expect(root).toHaveAttribute("data-mouth-openness", "0.000");
  await page.evaluate(
    (state) =>
      window.scene.message({
        type: "state",
        ...state,
        mood: "chaos",
        hype: { level: 4, shared: true },
      }),
    sceneState,
  );
  await expect(page.locator(".round-ink")).toHaveAttribute("data-mood", "chaos");
  await expect(page.locator(".round-ink")).toHaveAttribute("data-hype", "on");
  await expect
    .poll(async () => Number(await page.locator(".ri-gold").getAttribute("opacity")))
    .toBeGreaterThan(0);
  await page.evaluate(
    (state) =>
      window.scene.message({
        type: "state",
        ...state,
        step: "held",
        muted: true,
        heldBy: ["killed"],
      }),
    sceneState,
  );
  await expect(root).toHaveAttribute("data-pose", "muted");
  await page.waitForTimeout(300);
  await expect(page.locator(".ri-zip")).toHaveAttribute("opacity", "1");
  await expect(page.locator(".state-tag")).toHaveText("Muted");
  await page.evaluate(
    (state) =>
      window.scene.message({
        type: "state",
        ...state,
        step: "held",
        online: false,
        heldBy: ["offline"],
      }),
    sceneState,
  );
  await expect(root).toHaveAttribute("data-pose", "asleep");
  await page.waitForTimeout(300);
  for (const lid of await page.locator(".ri-closed-lid").all())
    await expect(lid).toHaveAttribute("opacity", "1");
  for (const eye of await page.locator(".ri-eye > g:first-child").all())
    await expect(eye).toHaveAttribute("opacity", "0");
  await page.screenshot({ path: info.outputPath("round-ink-asleep.png") });
  expect(errors).toEqual([]);
});
