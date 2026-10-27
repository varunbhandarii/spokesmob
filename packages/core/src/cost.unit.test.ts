import { expect, test } from "vitest";
import { modelCost, totalCost } from "./cost.js";

test("model cost separates uncached, cache read, cache write and output tokens", () => {
  const usage = { inputTokens: 1000, cachedTokens: 400, cacheWriteTokens: 200, outputTokens: 100 };
  expect(modelCost(usage)).toBeCloseTo(0.000119);
  expect(modelCost(usage, "fast")).toBeCloseTo(0.000238);
  expect(modelCost(null)).toBe(null);
  expect(modelCost({ ...usage, cachedTokens: 1001 })).toBe(null);
  expect(modelCost({ ...usage, outputTokens: Number.NaN })).toBe(null);
  expect(totalCost([0.1, 0.2])).toBeCloseTo(0.3);
  expect(totalCost([0.1, null])).toBe(null);
});
