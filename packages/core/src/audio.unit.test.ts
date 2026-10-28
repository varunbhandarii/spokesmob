import { expect, test } from "vitest";
import { analyzeAudio, decodePcm16LE, expectedDurationMs, frameMetrics } from "./audio.js";

test("PCM decoding respects little endian, negative full scale and byte offsets", () => {
  const bytes = Uint8Array.from([99, 0, 128, 255, 127, 0, 0, 0, 64, 99]);
  expect([...decodePcm16LE(bytes.subarray(1, 9))]).toEqual([-1, 32767 / 32768, 0, 0.5]);
  expect(() => decodePcm16LE(bytes.subarray(0, 3))).toThrow("complete");
});

test("twenty millisecond frame levels have known RMS and peak including partial frames", () => {
  const samples = new Float32Array(500).fill(0.5);
  const frames = frameMetrics(samples, 24000);
  expect(frames.map((frame) => frame.samples)).toEqual([480, 20]);
  for (const frame of frames) {
    expect(frame.rmsDbfs).toBeCloseTo(-6.0206);
    expect(frame.peakDbfs).toBeCloseTo(-6.0206);
  }
});

test("active frames, RMS, zero runs and leading silence are independently measured", () => {
  const samples = new Float32Array(2400);
  samples.fill(0.25, 480, 1440);
  const metrics = analyzeAudio(samples, 24000, -50);
  expect(metrics.durationMs).toBe(100);
  expect(metrics.activeFrameRatio).toBe(0.4);
  expect(metrics.activeRmsDbfs).toBeCloseTo(-12.0412);
  expect(metrics.longestZeroRunMs).toBe(40);
  expect(metrics.leadingSilenceMs).toBe(20);
  expect(metrics.clippingRatio).toBe(0);
});

test("silence, near silence and clipping produce distinct metrics", () => {
  const silence = analyzeAudio(new Float32Array(24000), 24000, -50);
  expect(silence).toMatchObject({
    activeFrameRatio: 0,
    rmsDbfs: Number.NEGATIVE_INFINITY,
    activeRmsDbfs: Number.NEGATIVE_INFINITY,
    leadingSilenceMs: 1000,
    longestZeroRunMs: 1000,
  });
  const quiet = analyzeAudio(new Float32Array(24000).fill(10 ** (-65 / 20)), 24000, -50);
  expect(quiet.peakDbfs).toBeCloseTo(-65);
  expect(quiet.activeFrames).toBe(0);
  expect(quiet.longestZeroRunMs).toBe(0);
  expect(
    analyzeAudio(Float32Array.from([-1, 32767 / 32768, 0, 0.5]), 24000, -50).clippingRatio,
  ).toBe(0.5);
});

test("duration estimates and malformed audio fail explicitly", () => {
  expect(expectedDurationMs(10, 2.5)).toBe(4000);
  expect(expectedDurationMs(0, 2.5)).toBe(0);
  expect(() => expectedDurationMs(-1, 2.5)).toThrow();
  expect(() => expectedDurationMs(1, 0)).toThrow();
  expect(() => frameMetrics(new Float32Array(1), 0)).toThrow();
  expect(() => analyzeAudio(Float32Array.from([Number.NaN]), 24000, -50)).toThrow();
  expect(() => analyzeAudio(new Float32Array(1), 24000, 0)).toThrow();
});
