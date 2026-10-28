import { expect, test } from "vitest";
import { analyzeAudio, decodePcm16LE } from "../../../../packages/core/src/audio.js";
import { testTonePcm } from "../../../../packages/core/src/test-tone.js";

test("the generated free tone is one second at 440 Hz with faded endpoints and a minus-twelve peak", () => {
  const samples = decodePcm16LE(testTonePcm());
  const metrics = analyzeAudio(samples, 24000, -50);
  expect(metrics.durationMs).toBe(1000);
  expect(metrics.peakDbfs).toBeCloseTo(-12, 2);
  expect(samples[0]).toBe(0);
  expect(samples.at(-1)).toBe(0);
  let crossings = 0;
  for (let index = 1; index < samples.length; index++)
    if ((samples[index - 1] ?? 0) <= 0 && (samples[index] ?? 0) > 0) crossings++;
  expect(crossings).toBe(440);
});
