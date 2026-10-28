import { expect, test } from "vitest";
import { SampleRing } from "./ring.js";

test("the ring wraps without losing order and fills unread output with silence", () => {
  const ring = new SampleRing(5);
  expect(ring.push(Float32Array.from([1, 2, 3, 4]))).toBe(true);
  const first = new Float32Array(3);
  expect(ring.read(first)).toBe(3);
  expect([...first]).toEqual([1, 2, 3]);
  expect(ring.push(Float32Array.from([5, 6, 7, 8]))).toBe(true);
  const second = new Float32Array(8).fill(99);
  expect(ring.read(second)).toBe(5);
  expect([...second]).toEqual([4, 5, 6, 7, 8, 0, 0, 0]);
});
test("overflow is atomic, clear removes queued audio and invalid spans fail", () => {
  const ring = new SampleRing(3);
  ring.push(Float32Array.from([1, 2]));
  expect(ring.push(Float32Array.from([3, 4]))).toBe(false);
  expect(ring.available).toBe(2);
  ring.clear();
  const output = new Float32Array(4).fill(1);
  ring.read(output);
  expect([...output]).toEqual([0, 0, 0, 0]);
  expect(() => ring.read(output, -1)).toThrow();
  expect(() => new SampleRing(0)).toThrow();
});
