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
      audio(rms: number, lowBand?: number): void;
    };
  }
}
const query = new URLSearchParams(location.search);
const scene = SCENES.find((item) => item === query.get("scene")) ?? "listening";
let sceneTime = 0;
let audioOverride: { rms: number; lowBand: number } | null = null;
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
  audio: (rms, lowBand = 0) => {
    audioOverride = { rms, lowBand };
  },
  message: (value) => store.receive(value),
  playback: (value) => store.playback(value),
  seek(at) {
    cursor = 0;
    locked = true;
    advance(Math.max(0, at));
  },
};
const heading = document.querySelector("#scene-heading");
if (heading) heading.textContent = `Synthetic scene / ${scene} / Round Ink`;
const renderer = createRenderer({
  root,
  store,
  harness: true,
  sample: () =>
    audioOverride?.rms ??
    (store.view().audioChannel === "main"
      ? 0.06
      : store.view().audioChannel === "dissent"
        ? 0.04
        : 0),
  lowBand: () => audioOverride?.lowBand ?? 0.2,
  beforeDraw: (now) => {
    if (!locked) advance(now);
  },
});
window.addEventListener("pagehide", () => renderer.destroy());
