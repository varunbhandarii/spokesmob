import { expect, test } from "@playwright/test";
import { controlClient, startMockLoop, until } from "./live-runtime.js";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });
test("the mock demo reveals only on local playback, moves its mouth and identifies simulation", async ({
  page,
}) => {
  test.setTimeout(45000);
  const runtime = await startMockLoop(true);
  let control: Awaited<ReturnType<typeof controlClient>> | undefined;
  const errors: string[] = [];
  try {
    page.on("pageerror", () => errors.push("script error"));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push("console error");
    });
    runtime.url.searchParams.set("audio", "1");
    await page.addInitScript((search) => {
      history.replaceState(null, "", location.pathname + search);
      const NativeContext = AudioContext;
      class ObservedContext extends NativeContext {
        constructor(options?: AudioContextOptions) {
          super(options);
          Object.assign(window, { demoAudioContext: this });
        }
      }
      Object.defineProperty(window, "AudioContext", { value: ObservedContext });
      const result = { started: false, ended: false, early: false, caption: false, mouth: 0 };
      Object.assign(window, { demoObservation: result });
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          const event = JSON.parse(data) as { type: string };
          if (event.type === "started") result.started = true;
          if (event.type === "ended") result.ended = true;
        }
        send.call(this, data);
      };
      new MutationObserver(() => {
        result.mouth = Math.max(
          result.mouth,
          Number(document.querySelector<HTMLElement>("#overlay")?.dataset.mouthOpenness) || 0,
        );
        const caption = document.querySelector<HTMLElement>(".caption");
        if (caption?.textContent && caption.getBoundingClientRect().height) {
          result.caption = true;
          if (!result.started) result.early = true;
        }
      }).observe(document, {
        subtree: true,
        attributes: true,
        characterData: true,
        childList: true,
      });
    }, runtime.url.search);
    try {
      await page.goto(`${runtime.url.origin}/overlay/?audio=1`);
    } catch {
      throw new Error("Local demo navigation failed");
    }
    await expect(page.locator("#status")).toContainText("audio ready");
    await expect(page.locator("#status")).toBeHidden();
    await expect(page.locator(".demo-tag")).toBeVisible();
    await expect(page.locator(".demo-tag")).toHaveText("Demo · simulated voice");
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    control = await controlClient(runtime.url);
    await until(
      () =>
        control?.messages.some(
          (message) =>
            message.type === "state" && message.step === "listening" && !message.heldBy.length,
        ) ?? false,
    );
    await expect(page.locator(".particle-canvas")).toHaveAttribute("data-count", "400");
    control.command({ action: "speak" });
    await page.waitForFunction(
      () => {
        const result = (window as unknown as { demoObservation: { ended: boolean } })
          .demoObservation;
        return result.ended;
      },
      undefined,
      { timeout: 18000 },
    );
    const result = await page.evaluate(
      () =>
        (
          window as unknown as {
            demoObservation: { started: boolean; early: boolean; caption: boolean; mouth: number };
          }
        ).demoObservation,
    );
    expect(result.started).toBe(true);
    expect(result.early).toBe(false);
    expect(result.caption).toBe(true);
    expect(result.mouth).toBeGreaterThan(0.1);
    await page.evaluate(() =>
      (window as unknown as { demoAudioContext: AudioContext }).demoAudioContext.suspend(),
    );
    await expect(page.locator("#status")).toBeVisible();
    await expect(page.locator("#status")).toContainText("audio blocked");
    await page.getByRole("button", { name: "Click to enable sound" }).click();
    await expect(page.locator("#status")).toBeHidden();
    await expect(page.getByRole("button", { name: "Click to enable sound" })).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    control?.close();
    await page.close();
    await runtime.close();
  }
});
