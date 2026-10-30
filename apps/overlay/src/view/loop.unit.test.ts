import { expect, test } from "vitest";
import { createFrameLoop, type FrameClock } from "./loop.js";
import { seededRandom } from "./random.js";

test("one frame loop pauses without advancing animation time while the source is inactive", () => {
  let now = 0;
  let id = 0;
  const frames = new Map<number, (at: number) => void>();
  const clock: FrameClock = {
    now: () => now,
    request(callback) {
      frames.set(++id, callback);
      return id;
    },
    cancel(key) {
      frames.delete(key);
    },
  };
  const seen: number[] = [];
  const loop = createFrameLoop((at) => seen.push(at), clock);
  const frame = (at: number) => {
    now = at;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(at);
  };
  loop.setActive(true);
  loop.setActive(true);
  expect(frames.size).toBe(1);
  frame(16);
  frame(32);
  loop.setActive(false);
  expect(frames.size).toBe(0);
  frame(10000);
  loop.setActive(true);
  frame(10016);
  expect(seen).toEqual([16, 32, 32, 48]);
  loop.destroy();
  expect(frames.size).toBe(0);
});
test("seeded visual choices are repeatable and stay in range", () => {
  const a = seededRandom(1729),
    b = seededRandom(1729),
    c = seededRandom(35);
  const left = Array.from({ length: 100 }, a),
    right = Array.from({ length: 100 }, b);
  expect(left).toEqual(right);
  expect(left.every((value) => value >= 0 && value < 1)).toBe(true);
  expect(left).not.toEqual(Array.from({ length: 100 }, c));
});
