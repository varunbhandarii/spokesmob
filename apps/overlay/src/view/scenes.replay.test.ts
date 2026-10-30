import { expect, test } from "vitest";
import { type Scene, sceneFrames } from "./scenes.js";
import { createViewStore } from "./store.js";

function replay(scene: Scene, through = Infinity) {
  const store = createViewStore();
  const frames = sceneFrames(scene).filter((frame) => frame.at <= through);
  for (const frame of frames) {
    if (frame.message) store.receive(frame.message);
    if (frame.playback) store.playback(frame.playback);
  }
  return { store, frames };
}
test("veto replay stays silent and hidden despite stale started and reveal events", () => {
  const { store } = replay("veto");
  expect(store.view()).toMatchObject({ pose: "idle", caption: null });
});
test("captions-only replay reveals after the hold using its original line identity", () => {
  expect(replay("captions-only", 1099).store.view().caption).toBeNull();
  const { store, frames } = replay("captions-only", 1100);
  expect(store.view()).toMatchObject({ pose: "reading", caption: { line: { take: 1 } } });
  expect(frames.filter((frame) => frame.message?.type === "reveal")).toHaveLength(1);
  expect(
    frames.some((frame) => frame.message?.type === "stop" || frame.message?.type === "play"),
  ).toBe(false);
});
test("failed-audio replay cancels old audio then reveals one fresh vetoable caption", () => {
  expect(replay("caption-fallback", 1099).store.view().caption).toBeNull();
  const { store, frames } = replay("caption-fallback");
  expect(store.view()).toMatchObject({ pose: "reading", caption: { line: { take: 2 } } });
  expect(frames.filter((frame) => frame.message?.type === "reveal")).toHaveLength(1);
  store.receive({ type: "veto", take: 2 });
  store.receive({ type: "reveal", take: 2 });
  expect(store.view().caption).toBeNull();
});
