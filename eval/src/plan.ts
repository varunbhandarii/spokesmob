import { z } from "zod";
import { createBlocklist } from "../../packages/core/src/blocklist.js";
import { clusterWindow } from "../../packages/core/src/cluster.js";
import { modelCost } from "../../packages/core/src/cost.js";
import { buildInput, STATIC_PREFIX } from "../../packages/core/src/prompt.js";
import { consensusOutputSchema } from "../../packages/core/src/schema.js";
import { assembleWindow } from "../../packages/core/src/window.js";
import type { GoldenWindow } from "./golden.js";

export const SPEND_LIMIT_USD = 0.5;
export interface EvaluationPlan {
  windows: number;
  samples: number;
  samplesPerWindow: number;
  minVoices: number;
  expectedPrimaryCalls: number;
  maximumGenerationCalls: number;
  maximumModelRequestsWithRateRetries: number;
  expectedCostUsd: number;
  projectedCostUsd: number;
  projectedCostWithRateRetriesUsd: number;
  serviceTier: "default" | "fast" | "interleaved";
  tiers?: { default: EvaluationPlan; fast: EvaluationPlan };
  tokenEstimate: "utf8 bytes divided by three; API count pending";
}
export function estimatedInputTokens(window: GoldenWindow): number {
  const assembled = assembleWindow(window.messages, window.windowOptions);
  const blocklist = createBlocklist();
  const clusters = clusterWindow(assembled, { isBlocked: (text) => blocklist.check(text).blocked });
  const input = buildInput(assembled, clusters, window.question);
  const schema = JSON.stringify(z.toJSONSchema(consensusOutputSchema));
  return Math.ceil(Buffer.byteLength(STATIC_PREFIX + input.userMessage + schema, "utf8") / 3) + 64;
}
export function estimatedCallCost(tokens: number, tier: "default" | "fast"): number {
  const cost = modelCost(
    { inputTokens: tokens, cachedTokens: 0, cacheWriteTokens: tokens, outputTokens: 256 },
    tier,
  );
  if (cost === null) throw new Error("Invalid cost projection");
  return cost;
}
export function evaluationPlan(
  windows: readonly GoldenWindow[],
  n: number,
  tier: "default" | "fast" | "interleaved",
  minVoices: number,
): EvaluationPlan {
  if (tier === "interleaved") {
    const standard = evaluationPlan(windows, n, "default", minVoices);
    const fast = evaluationPlan(windows, n, "fast", minVoices);
    return {
      ...standard,
      samples: standard.samples + fast.samples,
      samplesPerWindow: 2 * n,
      expectedPrimaryCalls: standard.expectedPrimaryCalls + fast.expectedPrimaryCalls,
      maximumGenerationCalls: standard.maximumGenerationCalls + fast.maximumGenerationCalls,
      maximumModelRequestsWithRateRetries:
        standard.maximumModelRequestsWithRateRetries + fast.maximumModelRequestsWithRateRetries,
      expectedCostUsd: standard.expectedCostUsd + fast.expectedCostUsd,
      projectedCostUsd: standard.projectedCostUsd + fast.projectedCostUsd,
      projectedCostWithRateRetriesUsd:
        standard.projectedCostWithRateRetriesUsd + fast.projectedCostWithRateRetriesUsd,
      serviceTier: "interleaved",
      tiers: { default: standard, fast },
    };
  }
  let expectedPrimaryCalls = 0;
  let maximumGenerationCalls = 0;
  let expectedCostUsd = 0;
  let projectedCostUsd = 0;
  for (const window of windows) {
    const assembled = assembleWindow(window.messages, window.windowOptions);
    if (assembled.voices < minVoices) continue;
    const tokens = estimatedInputTokens(window);
    maximumGenerationCalls += 2 * n;
    projectedCostUsd += estimatedCallCost(tokens, tier) * 2 * n;
    if (window.expect.speak === false) continue;
    expectedPrimaryCalls += n;
    // A planning estimate only: mostly cached static input, small output, no regeneration.
    const cached = Math.min(tokens, Math.floor(Buffer.byteLength(STATIC_PREFIX, "utf8") / 3));
    expectedCostUsd +=
      (modelCost({ inputTokens: tokens, cachedTokens: cached, outputTokens: 96 }, tier) ?? 0) * n;
  }
  return {
    windows: windows.length,
    samples: windows.length * n,
    samplesPerWindow: n,
    minVoices,
    expectedPrimaryCalls,
    maximumGenerationCalls,
    maximumModelRequestsWithRateRetries: maximumGenerationCalls * 3,
    expectedCostUsd,
    projectedCostUsd,
    projectedCostWithRateRetriesUsd: projectedCostUsd * 3,
    serviceTier: tier,
    tokenEstimate: "utf8 bytes divided by three; API count pending",
  };
}
