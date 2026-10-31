import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { controlClient, startMockLoop, until } from "./live-runtime.js";

test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

interface PlaybackObservation {
  started: boolean;
  captionBeforeStarted: boolean;
  captionAfterStarted: boolean;
  maxRms: number;
  maxMouth: number;
}

test("the live mock plays a verified tone, reveals on started and renders four hundred names smoothly", async ({
  page,
}, info) => {
  test.setTimeout(45000);
  const runtime = await startMockLoop();
  let control: Awaited<ReturnType<typeof controlClient>> | null = null;
  const errors: string[] = [];
  let metrics: Record<string, number | boolean> | null = null;
  try {
    page.on("pageerror", () => errors.push("browser script error"));
    page.on("console", (message) => {
      // Browser connection errors can include private query strings.
      if (message.type() === "error") errors.push("browser console error");
    });
    await page.route("**/*", (route) => {
      const target = new URL(route.request().url());
      if (target.origin !== runtime.url.origin) {
        errors.push("nonlocal browser request");
        return route.abort();
      }
      return route.continue();
    });
    runtime.url.searchParams.set("audio", "1");
    await page.addInitScript((search) => {
      // Authorize before the app loads without putting a private URL in navigation logs.
      history.replaceState(null, "", location.pathname + search);
      const observation: PlaybackObservation = {
        started: false,
        captionBeforeStarted: false,
        captionAfterStarted: false,
        maxRms: 0,
        maxMouth: 0,
      };
      (window as unknown as { playbackObservation: PlaybackObservation }).playbackObservation =
        observation;
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          try {
            if ((JSON.parse(data) as { type?: string }).type === "started")
              observation.started = true;
          } catch {
            /* Binary data is never interpreted as a playback report. */
          }
        }
        send.call(this, data);
      };
      new MutationObserver(() => {
        const root = document.querySelector<HTMLElement>("#overlay");
        const caption = document.querySelector<HTMLElement>(".caption");
        observation.maxRms = Math.max(observation.maxRms, Number(root?.dataset.rms) || 0);
        observation.maxMouth = Math.max(
          observation.maxMouth,
          Number(root?.dataset.mouthOpenness) || 0,
        );
        if (caption && caption.getBoundingClientRect().height > 0 && caption.textContent) {
          if (observation.started) observation.captionAfterStarted = true;
          else observation.captionBeforeStarted = true;
        }
      }).observe(document, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      });
    }, runtime.url.search);
    try {
      await page.goto(`${runtime.url.origin}/overlay/?audio=1`);
    } catch {
      throw new Error("Local overlay navigation failed");
    }
    await expect(page.locator("#status")).toContainText("audio ready");
    await expect(page.locator("#overlay")).toHaveAttribute("data-pose", "idle");
    await expect(page.locator(".caption")).toBeHidden();
    control = await controlClient(runtime.url);
    control.tone();
    await page.waitForFunction(() => {
      const value = (window as unknown as { playbackObservation: PlaybackObservation })
        .playbackObservation;
      return value.maxRms > 0.005 && value.maxMouth > 0.1 && value.captionAfterStarted;
    });
    await page.screenshot({ path: resolve("test-results/live-overlay.png") });
    await until(
      () => control?.messages.some((message) => message.type === "voice_result") ?? false,
    );
    const result = control.messages.find((message) => message.type === "voice_result");
    expect(result).toMatchObject({ data: { status: "verified", playback: "ended", attempts: [] } });
    const observation = await page.evaluate(
      () => (window as unknown as { playbackObservation: PlaybackObservation }).playbackObservation,
    );
    expect(observation.started).toBe(true);
    expect(observation.captionBeforeStarted).toBe(false);
    expect(observation.captionAfterStarted).toBe(true);
    expect(observation.maxRms).toBeGreaterThan(0.005);
    expect(observation.maxMouth).toBeGreaterThan(0.1);
    await expect(page.locator(".particle-canvas")).toHaveAttribute("data-count", "400");
    const timing = await page.evaluate(
      () =>
        new Promise<{ frames: number; elapsedMs: number; minParticles: number }>((done) => {
          const root = document.querySelector<HTMLElement>("#overlay");
          const canvas = document.querySelector<HTMLElement>(".particle-canvas");
          const first = Number(root?.dataset.frame);
          const start = performance.now();
          let minimum = 400;
          const sample = () => {
            minimum = Math.min(minimum, Number(canvas?.dataset.count) || 0);
            if (performance.now() - start < 5000) requestAnimationFrame(sample);
            else
              done({
                frames: Number(root?.dataset.frame) - first,
                elapsedMs: performance.now() - start,
                minParticles: minimum,
              });
          };
          requestAnimationFrame(sample);
        }),
    );
    const fps = (timing.frames * 1000) / timing.elapsedMs;
    expect(timing.minParticles).toBe(400);
    expect(fps).toBeGreaterThanOrEqual(55);
    expect(errors).toEqual([]);
    metrics = {
      ...observation,
      ...timing,
      fps,
      consoleErrors: errors.length,
      freeToneVerified: true,
    };
  } finally {
    control?.close();
    try {
      await page.close();
    } finally {
      await runtime.close();
    }
  }
  if (metrics) {
    metrics.cleanupComplete = true;
    const report = JSON.stringify(metrics, null, 2);
    await writeFile(resolve("test-results/live-smoke.json"), `${report}\n`, "utf8");
    await info.attach("live-smoke-metrics", { body: report, contentType: "application/json" });
  }
});
