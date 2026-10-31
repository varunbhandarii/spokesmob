import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { DEFAULT_BEAT_SETTINGS } from "../../../packages/core/src/beat-settings.js";
import { row } from "../../control/src/test-data.js";
import { sceneState } from "../src/view/scenes.js";

interface DockHarness {
  send(message: unknown): void;
  close(): void;
  commands: unknown[];
}
const notice = {
  type: "preview",
  take: 7,
  text: "Chat wants Gary.",
  dissent: "Some prefer Milo.",
  dissentPct: 18,
  pct: 71,
  voices: 312,
  holdMs: 3000,
  quiet: false,
};

async function openDock(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/api/state", (route) =>
    route.fulfill({ json: { state: sceneState, settings: DEFAULT_BEAT_SETTINGS } }),
  );
  await page.route("**/api/log?**", (route) => route.fulfill({ json: [] }));
  await page.addInitScript(
    ({ state, vetoed }) => {
      let socket: HarnessSocket | null = null;
      const commands: unknown[] = [];
      class HarnessSocket {
        readyState = 0;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onmessage: ((event: { data: string }) => void) | null = null;
        constructor() {
          socket = this;
          setTimeout(() => {
            this.readyState = 1;
            this.onopen?.();
          }, 0);
        }
        emit(message: unknown) {
          this.onmessage?.({ data: JSON.stringify(message) });
        }
        send(text: string) {
          const value = JSON.parse(text) as { type: string; command?: { action: string } };
          if (value.type === "hello")
            setTimeout(() => this.emit({ type: "hello", role: "control", audio: false, state }), 0);
          else commands.push(value);
          if (value.command?.action === "veto") {
            this.emit({ type: "state", ...state, step: "cooldown" });
            this.emit({ type: "log", row: vetoed });
          }
        }
        close() {
          this.readyState = 3;
          this.onclose?.();
        }
      }
      Object.defineProperty(window, "WebSocket", { value: HarnessSocket });
      (window as unknown as { dockHarness: DockHarness }).dockHarness = {
        send: (message) => socket?.emit(message),
        close: () => socket?.close(),
        commands,
      };
    },
    { state: sceneState, vetoed: { ...row(1), status: "vetoed", gate: "control", reason: "veto" } },
  );
  await page.goto("/control/?token=synthetic-visual-harness");
  await expect(page.locator("#connection")).toHaveText("connected");
  return errors;
}

test("the dock shows verified preview, countdown and a large veto with confirmed feedback", async ({
  page,
}, info) => {
  const errors = await openDock(page);
  await page.evaluate(
    ({ preview, state }) => {
      const harness = (window as unknown as { dockHarness: DockHarness }).dockHarness;
      harness.send(preview);
      harness.send({ type: "state", ...state, step: "preview" });
    },
    { preview: notice, state: sceneState },
  );
  const card = page.locator("#preview-card");
  await expect(card).toBeVisible();
  await expect(card.locator(".preview-line")).toHaveText(notice.text);
  await expect(card.locator(".preview-dissent")).toHaveText("18% \u00b7 Some prefer Milo.");
  await expect(card.locator(".preview-summary")).toHaveText("71% of 312 voices");
  await expect(card.locator(".preview-quiet")).toBeHidden();
  const start = await card
    .locator(".preview-fill")
    .evaluate((node) => getComputedStyle(node).transform);
  await expect
    .poll(() => card.locator(".preview-fill").evaluate((node) => getComputedStyle(node).transform))
    .not.toBe(start);
  await page.screenshot({ path: info.outputPath("dock-preview.png") });
  await page.evaluate(
    (state) =>
      (window as unknown as { dockHarness: DockHarness }).dockHarness.send({
        type: "state",
        ...state,
        step: "speaking",
      }),
    sceneState,
  );
  await expect(card).toBeHidden();
  await page.evaluate(
    ({ preview, state }) => {
      const harness = (window as unknown as { dockHarness: DockHarness }).dockHarness;
      harness.send({ ...preview, take: 8, quiet: true });
      harness.send({ type: "state", ...state, step: "preview", mode: "quiet" });
    },
    { preview: notice, state: sceneState },
  );
  await expect(card.locator(".preview-quiet")).toHaveText("Captions only");
  await expect(card.locator(".preview-veto")).toBeEnabled();
  await card.screenshot({ path: resolve("test-results/dock-preview.png") });
  await card.locator(".preview-veto").click();
  await expect(card).toHaveAttribute("data-kind", "vetoed");
  await expect(card.locator(".preview-title")).toHaveText("Vetoed");
  await expect(card.locator(".preview-line")).toBeHidden();
  await expect(card).toBeHidden({ timeout: 3000 });
  expect(
    await page.evaluate(
      () => (window as unknown as { dockHarness: DockHarness }).dockHarness.commands,
    ),
  ).toContainEqual(expect.objectContaining({ command: { action: "veto" } }));
  expect(errors).toEqual([]);
});

test("preview text is never HTML and a disconnected dock clears the card", async ({ page }) => {
  const errors = await openDock(page);
  await page.evaluate(
    ({ preview, state }) => {
      const harness = (window as unknown as { dockHarness: DockHarness }).dockHarness;
      harness.send({ ...preview, text: "Chat wants <b>Gary</b>." });
      harness.send({ type: "state", ...state, step: "preview" });
    },
    { preview: notice, state: sceneState },
  );
  await expect(page.locator(".preview-line")).toHaveText("Chat wants <b>Gary</b>.");
  await expect(page.locator(".preview-line b")).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { dockHarness: DockHarness }).dockHarness.close(),
  );
  await expect(page.locator("#preview-card")).toBeHidden();
  expect(errors).toEqual([]);
});
