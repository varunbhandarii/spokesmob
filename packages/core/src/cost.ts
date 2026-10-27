import type { ModelUsage } from "./types.js";

export const CONSENSUS_PRICES = Object.freeze({
  input: 0.1,
  cached: 0.01,
  cacheWrite: 0.125,
  output: 0.5,
});
export function modelCost(
  usage: ModelUsage | null,
  tier: "default" | "fast" = "default",
): number | null {
  if (!usage) return null;
  const write = usage.cacheWriteTokens ?? 0;
  if (
    [usage.inputTokens, usage.outputTokens, usage.cachedTokens, write].some(
      (value) => !Number.isFinite(value) || value < 0,
    ) ||
    usage.cachedTokens + write > usage.inputTokens
  )
    return null;
  const uncached = usage.inputTokens - usage.cachedTokens - write;
  return (
    ((uncached * CONSENSUS_PRICES.input +
      usage.cachedTokens * CONSENSUS_PRICES.cached +
      write * CONSENSUS_PRICES.cacheWrite +
      usage.outputTokens * CONSENSUS_PRICES.output) /
      1_000_000) *
    (tier === "fast" ? 2 : 1)
  );
}
export function totalCost(costs: readonly (number | null)[]): number | null {
  return costs.some((cost) => cost === null)
    ? null
    : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
}
