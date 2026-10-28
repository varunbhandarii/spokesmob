import { createHash } from "node:crypto";
import { type Clock, sleep, systemClock } from "../../apps/server/src/clock.js";
import { FakeModerationPort } from "../../apps/server/src/consensus/fakes.js";
import { classifyApiFailure } from "../../apps/server/src/consensus/model.js";
import { ModerationGate } from "../../apps/server/src/consensus/moderation.js";
import type {
  ApiFailure,
  ConsensusModelPort,
  ModelResult,
  ModerationPort,
} from "../../apps/server/src/consensus/ports.js";
import { StubConsensusModel } from "../../apps/server/src/consensus/stub-model.js";
import { synthesize } from "../../apps/server/src/consensus/synthesize.js";
import { createBlocklist } from "../../packages/core/src/blocklist.js";
import { clusterWindow } from "../../packages/core/src/cluster.js";
import { modelCost } from "../../packages/core/src/cost.js";
import { type BuiltInput, STATIC_PREFIX } from "../../packages/core/src/prompt.js";
import type { CallUsage, Cluster } from "../../packages/core/src/types.js";
import type { OutputModeration } from "../../packages/core/src/verify.js";
import { assembleWindow } from "../../packages/core/src/window.js";
import { assertSample } from "./assertions.js";
import type { GoldenWindow } from "./golden.js";
import {
  estimatedCallCost,
  estimatedInputTokens,
  evaluationPlan,
  SPEND_LIMIT_USD,
} from "./plan.js";
import { compareQuality, type QualityBaseline } from "./regression.js";
import {
  type ApiCallReport,
  type EvaluationReport,
  type ModelCallReport,
  type SampleReport,
  summarize,
  type VerificationAttemptReport,
} from "./report.js";

export interface EvaluationOptions {
  windows: readonly GoldenWindow[];
  n: number;
  offline: boolean;
  serviceTier: "default" | "fast" | "interleaved";
  maxCostUsd?: number;
  preflight?: "conservative" | "expected";
  baseline?: QualityBaseline;
  minVoices?: number;
  signal?: AbortSignal;
  clock?: Clock;
  onProgress?: (completed: number, total: number) => void;
  ports?: (tier: "default" | "fast") => { model: ConsensusModelPort; moderation: ModerationPort };
}
export async function evaluate(options: EvaluationOptions): Promise<EvaluationReport> {
  if (!Number.isSafeInteger(options.n) || options.n < 1 || !options.windows.length)
    throw new Error("Select windows and a positive sample count");
  if (!options.offline && !options.ports)
    throw new Error("Live evaluation needs explicit API ports");
  const minVoices = options.minVoices ?? 2;
  const clock = options.clock ?? systemClock;
  const plan = evaluationPlan(options.windows, options.n, options.serviceTier, minVoices);
  const maxCost = options.maxCostUsd ?? SPEND_LIMIT_USD;
  const preflight = options.preflight ?? "conservative";
  const preflightProjection =
    preflight === "expected" ? plan.expectedCostUsd : plan.projectedCostWithRateRetriesUsd;
  if (!Number.isFinite(maxCost) || maxCost <= 0 || maxCost > SPEND_LIMIT_USD)
    throw new Error("Cost limit must be positive and at most $0.50");
  if (!options.offline && preflightProjection > maxCost)
    throw new Error(`Projected cost exceeds $${maxCost.toFixed(2)}; no API calls made`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let aborted: string | null = options.signal?.aborted ? "aborted" : null;
  const failRun = (reason: string) => {
    aborted ??= reason;
    controller.abort();
  };
  let committedCost = 0;
  const failureStreak = { model: 0, moderation: 0 };
  const recordApi = (source: "model" | "moderation", failure: ApiFailure | null) => {
    if (failure === "auth") return failRun("auth_error");
    failureStreak[source] = failure ? failureStreak[source] + 1 : 0;
    if (failureStreak[source] >= 3) failRun(`${source}_consecutive_api_failures`);
  };
  const tiers: ("default" | "fast")[] =
    options.serviceTier === "interleaved" ? ["default", "fast"] : [options.serviceTier];
  const jobs = options.windows.flatMap((window) =>
    Array.from({ length: options.n }, (_, index) =>
      tiers.map((serviceTier) => ({ window, sample: index + 1, serviceTier })),
    ).flat(),
  );
  const estimates = new Map(
    options.windows.map((window) => [window.id, estimatedInputTokens(window)]),
  );
  let next = 0;
  let completed = 0;
  const samples: (SampleReport | undefined)[] = Array.from({ length: jobs.length });
  async function worker() {
    const portsByTier = new Map<
      "default" | "fast",
      { model: ConsensusModelPort; moderation: ModerationPort }
    >();
    const portsFor = (tier: "default" | "fast") => {
      let ports = portsByTier.get(tier);
      if (!ports) {
        ports = options.ports?.(tier) ?? {
          model: new StubConsensusModel(),
          moderation: new FakeModerationPort(),
        };
        portsByTier.set(tier, ports);
      }
      return ports;
    };
    let apiCalls: ApiCallReport[] = [];
    const moderationPort: ModerationPort = {
      moderate: async (texts, signal) => {
        const start = clock.now();
        const sampleApiCalls = apiCalls;
        try {
          const response = await portsFor(tiers[0] ?? "default").moderation.moderate(texts, signal);
          sampleApiCalls.push({
            source: "moderation",
            failure: null,
            latencyMs: clock.now() - start,
          });
          recordApi("moderation", null);
          return response;
        } catch (error) {
          if (!controller.signal.aborted) {
            const failure = signal?.aborted
              ? "timeout"
              : (classifyApiFailure(error) ?? "transport");
            sampleApiCalls.push({ source: "moderation", failure, latencyMs: clock.now() - start });
            recordApi("moderation", failure);
          }
          throw error;
        }
      },
    };
    const gate = new ModerationGate({ port: moderationPort, clock });
    const blocklist = createBlocklist();
    while (!controller.signal.aborted) {
      const index = next++;
      const job = jobs[index];
      if (!job) break;
      apiCalls = [];
      const tier = job.serviceTier;
      const ports = portsFor(tier);
      const traces: { input: BuiltInput; result: ModelResult }[] = [];
      const calls: ModelCallReport[] = [];
      const verifications: VerificationAttemptReport[] = [];
      let fallbackAttempted = false;
      let fallbackModeration: OutputModeration = { status: "error" };
      const estimatedTokens = estimates.get(job.window.id);
      if (estimatedTokens === undefined) throw new Error("Missing cost projection");
      const estimatedCost = estimatedCallCost(estimatedTokens, tier);
      const model: ConsensusModelPort = {
        generate: async (input, signal) => {
          const extraUsage: CallUsage[] = [];
          let latency = 0;
          for (let retry = 0; ; retry++) {
            if (!options.offline) {
              if (committedCost + estimatedCost > maxCost) {
                failRun("projected_cost_limit");
                throw new Error("Budget exhausted");
              }
              committedCost += estimatedCost;
            }
            let generated: ModelResult;
            const callStart = clock.now();
            try {
              generated = await ports.model.generate(input, signal);
            } catch (error) {
              generated = {
                output: null,
                failure: signal?.aborted ? "aborted" : "model_error",
                inputModeration: { status: "error" },
                outputModeration: { status: "error" },
                usage: null,
                latencyMs: clock.now() - callStart,
                apiFailure: signal?.aborted ? null : (classifyApiFailure(error) ?? "transport"),
              };
            }
            const apiFailure =
              generated.apiFailure ??
              (generated.failure === "model_timeout"
                ? "timeout"
                : generated.failure === "model_rate_limit"
                  ? "rate_limit"
                  : generated.failure === "model_error"
                    ? "transport"
                    : null);
            if (apiFailure === "timeout" || apiFailure === "server")
              generated = { ...generated, usage: null };
            if (!signal?.aborted) recordApi("model", apiFailure);
            apiCalls.push({ source: "model", failure: apiFailure, latencyMs: generated.latencyMs });
            const costUsd = modelCost(generated.usage, tier);
            if (!options.offline && costUsd !== null) committedCost += costUsd - estimatedCost;
            if (!options.offline && committedCost > maxCost) failRun("projected_cost_limit");
            calls.push({
              failure: generated.failure,
              incompleteReason: generated.incompleteReason ?? null,
              latencyMs: generated.latencyMs,
              usage: generated.usage,
              costUsd,
              apiFailure,
            });
            traces.push({ input, result: generated });
            latency += generated.latencyMs;
            if (generated.failure === "model_rate_limit" && retry < 2 && !signal?.aborted) {
              extraUsage.push({
                source: "model",
                usage: generated.usage,
                serviceTier: tier,
                costUsd,
              });
              const delay = 250 * 2 ** retry;
              await sleep(clock, delay);
              latency += delay;
              if (signal?.aborted)
                return {
                  ...generated,
                  failure: "aborted",
                  latencyMs: latency,
                  additionalUsage: extraUsage.slice(0, -1),
                };
              continue;
            }
            return {
              ...generated,
              latencyMs: latency,
              additionalUsage: [...extraUsage, ...(generated.additionalUsage ?? [])],
            };
          }
        },
      };
      const outputPort: ModerationPort = {
        moderate: async (texts, signal) => {
          const response = await moderationPort.moderate(texts, signal);
          const item = response.results[0];
          fallbackModeration =
            response.results.length === 1 && item && typeof item.flagged === "boolean"
              ? {
                  status: "ok",
                  flagged: item.flagged || Object.values(item.categories).some(Boolean),
                }
              : { status: "error" };
          return response;
        },
      };
      let finalWindow = assembleWindow(job.window.messages, job.window.windowOptions);
      let finalClusters: readonly Cluster[] = clusterWindow(finalWindow);
      const result = await synthesize({
        ...job.window,
        minVoices,
        serviceTier: tier,
        model,
        moderation: gate,
        outputModeration: outputPort,
        blocklist,
        signal: controller.signal,
        clock,
        onWindow: (window, clusters) => {
          finalWindow = window;
          finalClusters = clusters;
        },
        onVerification: (attempt) => {
          const rejected = attempt.failures.length > 0;
          const encoded =
            job.window.encoded ||
            [attempt.line, attempt.dissent].some((text) => !!text && blocklist.check(text).blocked);
          verifications.push({
            ...attempt,
            line: rejected && !encoded ? attempt.line : null,
            dissent: rejected && !encoded ? attempt.dissent : null,
            offendingTokens:
              rejected && !encoded ? attempt.offendingTokens : { line: [], dissent: [] },
            ...(rejected && encoded
              ? {
                  ...(attempt.line
                    ? { line_b64: Buffer.from(attempt.line).toString("base64") }
                    : {}),
                  ...(attempt.dissent
                    ? { dissent_b64: Buffer.from(attempt.dissent).toString("base64") }
                    : {}),
                  offendingTokens_b64: Buffer.from(
                    JSON.stringify(attempt.offendingTokens),
                  ).toString("base64"),
                }
              : {}),
          });
        },
        onFallback: () => {
          fallbackAttempted = true;
        },
      });
      const accepted = [...traces]
        .reverse()
        .find((trace) => trace.result.output?.line === result.line && !trace.result.failure);
      const moderation = result.fallback
        ? fallbackModeration
        : (accepted?.result.outputModeration ?? { status: "error" });
      const dissentKey =
        accepted?.input.mapping.get(accepted.result.output?.dissent_cluster_id ?? "") ?? null;
      const failures = assertSample(job.window, result, {
        window: finalWindow,
        clusters: finalClusters,
        blocklist,
        moderation,
        dissentClusterKey: dissentKey,
        minVoices,
      });
      const protectedText = (text: string | null) =>
        !!text && (job.window.encoded || blocklist.check(text).blocked);
      samples[index] = {
        id: job.window.id,
        tags: job.window.tags,
        sample: job.sample,
        serviceTier: tier,
        order: index + 1,
        pass: failures.length === 0,
        failures,
        status: result.status,
        reason: result.reason,
        line: protectedText(result.line) ? null : result.line,
        dissent: protectedText(result.dissent) ? null : result.dissent,
        ...(protectedText(result.line)
          ? { line_b64: Buffer.from(result.line ?? "").toString("base64") }
          : {}),
        ...(protectedText(result.dissent)
          ? { dissent_b64: Buffer.from(result.dissent ?? "").toString("base64") }
          : {}),
        pct: result.pct,
        voices: result.voices,
        mood: result.mood,
        citedClusterKeys: result.citedClusterKeys,
        answersQuestion: result.answersQuestion,
        attempts: result.attempts,
        fallback: result.fallback,
        latency: result.latency,
        usage: result.usage,
        calls,
        apiCalls,
        verifications,
        fallbackAttempted,
      };
      options.onProgress?.(++completed, jobs.length);
    }
  }
  try {
    await Promise.all(
      Array.from(
        { length: options.serviceTier === "interleaved" ? 1 : Math.min(4, jobs.length) },
        () => worker(),
      ),
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  if (options.signal?.aborted) aborted ??= "aborted";
  const finished = samples.filter((sample): sample is SampleReport => sample !== undefined);
  const baseline = options.baseline;
  return {
    createdAt: new Date(clock.now()).toISOString(),
    offline: options.offline,
    unmoderated: options.offline,
    serviceTier: options.serviceTier,
    prefixSha256: createHash("sha256").update(STATIC_PREFIX).digest("hex"),
    plan,
    budget: {
      preflight,
      maxCostUsd: maxCost,
      preflightProjectionUsd: preflightProjection,
      reservedCostUsd: committedCost,
    },
    aborted,
    summary: summarize(finished),
    tierSummaries: Object.fromEntries(
      tiers.map((tier) => [
        tier,
        summarize(finished.filter((sample) => sample.serviceTier === tier)),
      ]),
    ),
    qualityRegression: baseline
      ? Object.fromEntries(
          tiers.map((tier) => [
            tier,
            aborted
              ? { comparable: false, pass: null, categories: {} }
              : compareQuality(
                  baseline,
                  finished.filter((sample) => sample.serviceTier === tier),
                ),
          ]),
        )
      : {},
    samples: finished,
  };
}
