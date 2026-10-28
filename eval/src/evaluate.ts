import { createHash } from "node:crypto";
import { type Clock, sleep, systemClock } from "../../apps/server/src/clock.js";
import { FakeModerationPort } from "../../apps/server/src/consensus/fakes.js";
import { ModerationGate } from "../../apps/server/src/consensus/moderation.js";
import type {
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
import {
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
  serviceTier: "default" | "fast";
  minVoices?: number;
  signal?: AbortSignal;
  clock?: Clock;
  ports?: () => { model: ConsensusModelPort; moderation: ModerationPort };
}
export async function evaluate(options: EvaluationOptions): Promise<EvaluationReport> {
  if (!Number.isSafeInteger(options.n) || options.n < 1 || !options.windows.length)
    throw new Error("Select windows and a positive sample count");
  if (!options.offline && !options.ports)
    throw new Error("Live evaluation needs explicit API ports");
  const minVoices = options.minVoices ?? 2;
  const clock = options.clock ?? systemClock;
  const plan = evaluationPlan(options.windows, options.n, options.serviceTier, minVoices);
  if (!options.offline && plan.projectedCostWithRateRetriesUsd > SPEND_LIMIT_USD)
    throw new Error("Projected cost exceeds $0.50; no API calls made");
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
  const jobs = options.windows.flatMap((window) =>
    Array.from({ length: options.n }, (_, index) => ({ window, sample: index + 1 })),
  );
  const estimates = new Map(
    options.windows.map((window) => [
      window.id,
      estimatedCallCost(estimatedInputTokens(window), options.serviceTier),
    ]),
  );
  let next = 0;
  const samples: (SampleReport | undefined)[] = Array.from({ length: jobs.length });
  async function worker() {
    const ports = options.ports?.() ?? {
      model: new StubConsensusModel(),
      moderation: new FakeModerationPort(),
    };
    const gate = new ModerationGate({ port: ports.moderation, clock });
    const blocklist = createBlocklist();
    while (!controller.signal.aborted) {
      const index = next++;
      const job = jobs[index];
      if (!job) break;
      const traces: { input: BuiltInput; result: ModelResult }[] = [];
      const calls: ModelCallReport[] = [];
      const verifications: VerificationAttemptReport[] = [];
      let fallbackAttempted = false;
      let fallbackModeration: OutputModeration = { status: "error" };
      const estimatedCost = estimates.get(job.window.id);
      if (estimatedCost === undefined) throw new Error("Missing cost projection");
      const model: ConsensusModelPort = {
        generate: async (input, signal) => {
          const extraUsage: CallUsage[] = [];
          let latency = 0;
          for (let retry = 0; ; retry++) {
            if (!options.offline) {
              if (committedCost + estimatedCost > SPEND_LIMIT_USD) {
                failRun("projected_cost_limit");
                throw new Error("Budget exhausted");
              }
              committedCost += estimatedCost;
            }
            let generated: ModelResult;
            const callStart = clock.now();
            try {
              generated = await ports.model.generate(input, signal);
            } catch {
              generated = {
                output: null,
                failure: signal?.aborted ? "aborted" : "model_error",
                inputModeration: { status: "error" },
                outputModeration: { status: "error" },
                usage: null,
                latencyMs: clock.now() - callStart,
              };
            }
            const costUsd = modelCost(generated.usage, options.serviceTier);
            if (!options.offline && costUsd !== null) committedCost += costUsd - estimatedCost;
            if (!options.offline && committedCost > SPEND_LIMIT_USD)
              failRun("projected_cost_limit");
            calls.push({
              failure: generated.failure,
              incompleteReason: generated.incompleteReason ?? null,
              latencyMs: generated.latencyMs,
              usage: generated.usage,
              costUsd,
            });
            traces.push({ input, result: generated });
            latency += generated.latencyMs;
            if (generated.failure === "model_rate_limit" && retry < 2 && !signal?.aborted) {
              extraUsage.push({
                source: "model",
                usage: generated.usage,
                serviceTier: options.serviceTier,
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
            if (
              !options.offline &&
              (generated.failure === "model_rate_limit" ||
                generated.failure === "model_timeout" ||
                generated.failure === "model_error" ||
                generated.inputModeration.status === "error" ||
                generated.outputModeration.status === "error")
            )
              failRun(generated.failure ?? "moderation_error");
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
          const response = await ports.moderation.moderate(texts, signal);
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
        serviceTier: options.serviceTier,
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
      if (
        !options.offline &&
        ["moderation_unavailable", "moderation_mapping", "moderation_error"].includes(
          result.reason ?? "",
        )
      )
        failRun(result.reason ?? "moderation_error");
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
        verifications,
        fallbackAttempted,
      };
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, () => worker()));
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
  if (options.signal?.aborted) aborted ??= "aborted";
  const finished = samples.filter((sample): sample is SampleReport => sample !== undefined);
  return {
    createdAt: new Date(clock.now()).toISOString(),
    offline: options.offline,
    unmoderated: options.offline,
    serviceTier: options.serviceTier,
    prefixSha256: createHash("sha256").update(STATIC_PREFIX).digest("hex"),
    plan,
    aborted,
    summary: summarize(finished),
    samples: finished,
  };
}
