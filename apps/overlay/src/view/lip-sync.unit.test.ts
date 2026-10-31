import { expect, test } from "vitest";
import { LAYOUTS } from "./layout.js";
import { createLipSync, mouthShape, particleGaze } from "./lip-sync.js";

const main = {
  nowMs: 30,
  dtMs: 30,
  pose: "speaking" as const,
  channel: "main" as const,
  rms: 0.125,
  lowBand: 0,
};
test("lip envelope uses a thirty millisecond attack and one hundred twenty millisecond release", () => {
  const lips = createLipSync();
  const first = lips.update(main);
  expect(first.openness).toBeCloseTo(1 - Math.exp(-1), 8);
  const quiet = lips.update({ ...main, nowMs: 150, dtMs: 120, rms: 0 });
  expect(quiet.openness).toBeCloseTo(first.openness * Math.exp(-1), 8);
});
test("normal amplitude maps to four mouth shapes and low-frequency energy selects the round shape", () => {
  expect([0, 0.1, 0.4, 0.9].map((value) => mouthShape(value, 0))).toEqual([
    "closed",
    "mid",
    "open",
    "wide",
  ]);
  expect(mouthShape(0.4, 0.8)).toBe("o");
  expect(mouthShape(0.01, 1)).toBe("closed");
});
test("dissent scales the same smoothed envelope to sixty percent without changing audio", () => {
  const mainLips = createLipSync(),
    asideLips = createLipSync();
  const a = mainLips.update({ ...main, dtMs: 300 });
  const b = asideLips.update({ ...main, dtMs: 300, pose: "aside", channel: "dissent" });
  expect(b.openness).toBeCloseTo(a.openness * 0.6, 8);
  expect(b.openness).toBeLessThanOrEqual(0.6);
});
test("ended speech eases completely shut over two hundred fifty milliseconds", () => {
  const lips = createLipSync();
  const start = lips.update({ ...main, dtMs: 300 });
  const ending = { ...main, pose: "settle" as const, channel: null, rms: 0, nowMs: 100 };
  expect(lips.update(ending).openness).toBe(start.openness);
  expect(lips.update({ ...ending, nowMs: 225 }).openness).toBeCloseTo(start.openness / 2, 8);
  expect(lips.update({ ...ending, nowMs: 350 })).toEqual({ openness: 0, shape: "closed" });
});
test("cancel, mute, sleep, preview and reading close immediately and ignore stale RMS", () => {
  for (const pose of ["idle", "muted", "asleep", "inhale", "thinking", "reading"] as const) {
    const lips = createLipSync();
    lips.update(main);
    expect(lips.update({ ...main, pose, rms: 1 })).toEqual({ openness: 0, shape: "closed" });
  }
  expect(createLipSync().update({ ...main, rms: Number.NaN }).openness).toBe(0);
});
test("listening gaze follows the newest particle with normalized, clamped coordinates", () => {
  const face = LAYOUTS.wide.face;
  expect(particleGaze(null, face)).toEqual({ x: 0, y: 0 });
  expect(particleGaze({ x: face.x + face.width / 2, y: face.y + face.height / 2 }, face)).toEqual({
    x: 0,
    y: 0,
  });
  expect(particleGaze({ x: 1920, y: 0 }, face)).toEqual({ x: 1, y: -1 });
});
