import { expect, test } from "vitest";
import { lowBandShare } from "./spectrum.js";

test("low-band detection compares linear power and ignores silence and DC", () => {
  const bins = new Float32Array(512).fill(-Infinity);
  expect(lowBandShare(bins, 24000 / 1024)).toBe(0);
  bins[0] = 0;
  expect(lowBandShare(bins, 24000 / 1024)).toBe(0);
  bins[19] = -20;
  bins[43] = -30;
  expect(lowBandShare(bins, 24000 / 1024)).toBeCloseTo(10 / 11, 5);
});
test("high-frequency sound does not select a round mouth and invalid bin widths are silent", () => {
  const bins = new Float32Array(512).fill(-Infinity);
  bins[43] = -10;
  expect(lowBandShare(bins, 24000 / 1024)).toBe(0);
  expect(lowBandShare(bins, Number.NaN)).toBe(0);
});
