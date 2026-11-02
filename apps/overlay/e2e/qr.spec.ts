import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";
import type { QRCode } from "jsqr";

const decode = createRequire(import.meta.url)("jsqr") as (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) => QRCode | null;

test("the stage sticker QR decodes with its full quiet zone and local fonts", async ({ page }) => {
  await page.goto("/overlay/scene.html?scene=speaking&layout=stage");
  await page.waitForFunction(() => !!window.scene);
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scene.seek(1800);
  });
  await page.waitForTimeout(300);
  const pixels = await page.locator(".channel-qr svg").evaluate(async (svg) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 560;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("QR canvas unavailable");
    context.drawImage(image, 0, 0, 560, 560);
    return Array.from(context.getImageData(0, 0, 560, 560).data);
  });
  expect(decode(new Uint8ClampedArray(pixels), 560, 560)?.data).toBe(
    "https://twitch.tv/synthetic_channel",
  );
});
