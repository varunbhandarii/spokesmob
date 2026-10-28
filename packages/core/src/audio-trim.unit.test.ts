import { expect, test } from "vitest";
import { decodePcm16LE } from "./audio.js";
import { trimVerifiedAudio } from "./audio-trim.js";

function constantPcm(leading: number, active: number, trailing: number) {
  const pcm = new Uint8Array((leading + active + trailing) * 48);
  const view = new DataView(pcm.buffer);
  for (let index = leading * 24; index < (leading + active) * 24; index++)
    view.setInt16(index * 2, 6000, true);
  return pcm;
}
test("release trimming keeps the requested silence and never mutates raw PCM", () => {
  const raw = constantPcm(300, 1000, 400);
  const original = raw.slice();
  const result = trimVerifiedAudio(raw);
  expect(result.trim).toEqual({ leadingMs: 200, trailingMs: 250, totalMs: 450 });
  expect(result.durationMs).toBe(1250);
  expect(raw).toEqual(original);
  const samples = decodePcm16LE(result.pcm);
  expect(samples[2399]).toBe(0);
  expect(samples[2400]).toBeGreaterThan(0);
  expect(samples[26400]).toBe(0);
});
test("ten-millisecond fades start and end at zero and preserve the middle", () => {
  const raw = constantPcm(0, 1000, 0);
  const result = trimVerifiedAudio(raw);
  const samples = decodePcm16LE(result.pcm);
  expect(result.trim.totalMs).toBe(0);
  expect(samples[0]).toBe(0);
  expect(samples[119]).toBeCloseTo(((6000 / 32768) * 119) / 239, 4);
  expect(samples[239]).toBe(6000 / 32768);
  expect(samples[1000]).toBe(6000 / 32768);
  expect(samples.at(-1)).toBe(0);
  expect(samples.at(-240)).toBe(6000 / 32768);
});
test("shorter existing silence is retained and silent PCM is never repaired", () => {
  expect(trimVerifiedAudio(constantPcm(40, 1000, 80)).trim.totalMs).toBe(0);
  expect(() => trimVerifiedAudio(new Uint8Array(48000))).toThrow("active audio");
});
