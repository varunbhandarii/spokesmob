import type { PlaybackReport } from "../../../packages/core/src/overlay-protocol.js";
import { createRenderer } from "./view/render.js";
import { SCENES, type Scene, sceneFrames } from "./view/scenes.js";
import { createViewStore } from "./view/store.js";

declare global {
  interface Window {
    scene: {
      seek(at: number): void;
      message(value: unknown): boolean;
      playback(value: PlaybackReport): void;
    };
  }
}
const query = new URLSearchParams(location.search);
const scene = SCENES.find((item) => item === query.get("scene")) ?? "listening";
let sceneTime = 0;
const store = createViewStore(query.get("layout"), () => sceneTime);
const root = document.querySelector<HTMLElement>("#overlay");
if (!root) throw new Error("Scene root unavailable");
const frames = sceneFrames(scene as Scene);
let cursor = 0;
let locked = false;
const advance = (at: number) => {
  while (cursor < frames.length && (frames[cursor]?.at ?? Infinity) <= at) {
    const frame = frames[cursor++];
    sceneTime = frame?.at ?? at;
    if (frame?.message) store.receive(frame.message);
    if (frame?.playback) store.playback(frame.playback);
  }
  sceneTime = at;
  root.dataset.ready = "true";
};
window.scene = {
  message: (value) => store.receive(value),
  playback: (value) => store.playback(value),
  seek(at) {
    cursor = 0;
    locked = true;
    advance(Math.max(0, at));
  },
};
const heading = document.querySelector("#scene-heading");
if (heading) heading.textContent = `Synthetic scene / ${scene} / temporary face`;
const renderer = createRenderer({
  root,
  store,
  harness: true,
  beforeDraw: (now) => {
    if (!locked) advance(now);
  },
});
window.addEventListener("pagehide", () => renderer.destroy());
