import type { Logger } from "pino";
import type { Blocklist } from "../../../../packages/core/src/blocklist.js";
import { clusterWindow } from "../../../../packages/core/src/cluster.js";
import { modelCost, totalCost } from "../../../../packages/core/src/cost.js";
import { fallbackLine } from "../../../../packages/core/src/fallback.js";
import { buildInput } from "../../../../packages/core/src/prompt.js";
import { THRESHOLDS } from "../../../../packages/core/src/thresholds.js";
import type {
  CallUsage,
  ChatMessage,
  Cluster,
  RuleCode,
  SynthesisResult,
  Window,
} from "../../../../packages/core/src/types.js";
import { type OutputModeration, verifyLine } from "../../../../packages/core/src/verify.js";
import { assembleWindow, type WindowOptions } from "../../../../packages/core/src/window.js";
import { type Clock, systemClock } from "../clock.js";
import { ModerationFailure, type ModerationGate, moderationDecision } from "./moderation.js";
import type {
  ConsensusModelPort,
  ModelResult,
  ModerationPort,
  VerificationAttempt,
} from "./ports.js";

export interface SynthesisOptions {
  messages: readonly ChatMessage[];
  windowOptions?: WindowOptions;
  question?: string | null;
  previousLine?: string | null;
  questionChanged?: boolean;
  minVoices?: number;
  serviceTier?: "default" | "fast";
  moderation: ModerationGate;
  outputModeration: ModerationPort;
  model: ConsensusModelPort;
  blocklist: Blocklist;
  signal?: AbortSignal;
  clock?: Clock;
  log?: Pick<Logger, "info">;
  onWindow?: (window: Window, clusters: readonly Cluster[]) => void;
  onVerification?: (attempt: VerificationAttempt) => void;
  onFallback?: () => void;
}
export async function synthesize(options: SynthesisOptions): Promise<SynthesisResult> {
  const clock = options.clock ?? systemClock;
  const start = clock.now();
  const tier = options.serviceTier ?? "default";
  const minVoices = options.minVoices ?? THRESHOLDS.MIN_VOICES;
  const windowOptions = options.windowOptions ?? { seed: 1 };
  const excluded = new Set(windowOptions.excludedBucketKeys);
  let window = assembleWindow(options.messages, windowOptions);
  let clusters: Cluster[] = [];
  const usage: CallUsage[] = [];
  const result: SynthesisResult = {
    status: "suppressed",
    line: null,
    dissent: null,
    citedClusterKeys: [],
    pct: 0,
    voices: window.voices,
    citedAuthors: [],
    citedNames: [],
    mood: null,
    answersQuestion: false,
    fallback: false,
    attempts: 0,
    gate: null,
    reason: null,
    latency: {
      assembly: clock.now() - start,
      clustering: 0,
      inputModeration: 0,
      model: 0,
      verification: 0,
      total: 0,
    },
    usage,
    costUsd: null,
  };
  const finish = (gate: SynthesisResult["gate"], reason: RuleCode | null): SynthesisResult => {
    usage.push(...options.moderation.drainUsage());
    result.gate = gate;
    result.reason = reason;
    result.voices = window.voices;
    result.latency.total = clock.now() - start;
    result.costUsd = totalCost(usage.map((call) => call.costUsd));
    options.log?.info(
      {
        status: result.status,
        gate,
        reason,
        voices: result.voices,
        pct: result.pct,
        keys: result.citedClusterKeys,
        attempts: result.attempts,
        fallback: result.fallback,
        exemplars: clusters
          .slice(0, 12)
          .map((cluster) => ({ key: cluster.key, count: cluster.exemplars.length })),
      },
      "Consensus window resolved",
    );
    return result;
  };
  const aborted = () => options.signal?.aborted;
  if (aborted()) return finish("aborted", "aborted");
  if (window.voices < minVoices) return finish("intake", "not_enough_voices");
  for (let round = 0; round <= 2; round++) {
    const clusterStart = clock.now();
    clusters = clusterWindow(window, {
      isBlocked: (text) => options.blocklist.check(text).blocked,
    });
    result.latency.clustering += clock.now() - clusterStart;
    const exemplars = clusters
      .slice(0, THRESHOLDS.TOP_CLUSTERS)
      .flatMap((cluster) => cluster.exemplars);
    const moderationStart = clock.now();
    let drops: string[];
    try {
      const mapped = await options.moderation.resolve(
        exemplars.map((item) => item.text),
        options.signal,
      );
      drops = [];
      for (const exemplar of exemplars) {
        const value = mapped.get(exemplar.text);
        if (!value) throw new ModerationFailure("moderation_mapping");
        const decision = moderationDecision(value);
        if (decision === "skip") return finish("input_moderation", "input_moderation");
        if (decision === "drop") drops.push(exemplar.bucketKey);
      }
    } catch (error) {
      return finish(
        aborted() ? "aborted" : "input_moderation",
        error instanceof ModerationFailure ? error.reason : "input_moderation",
      );
    } finally {
      result.latency.inputModeration += clock.now() - moderationStart;
    }
    if (aborted()) return finish("aborted", "aborted");
    if (!drops.length) break;
    if (round === 2) return finish("input_moderation", "moderation_drop_limit");
    for (const key of drops) excluded.add(key);
    const assemblyStart = clock.now();
    window = assembleWindow(options.messages, { ...windowOptions, excludedBucketKeys: excluded });
    result.latency.assembly += clock.now() - assemblyStart;
    if (window.voices < minVoices) return finish("input_moderation", "not_enough_voices");
  }
  options.onWindow?.(window, clusters);
  const names = window.moodMessages.flatMap((message) => [
    message.authorName,
    ...(message.authorLogin ? [message.authorLogin] : []),
  ]);
  const context = (mapping: ReadonlyMap<string, string>, moderation: OutputModeration) => ({
    clusters,
    mapping,
    voices: window.voices,
    blocklist: options.blocklist,
    question: options.question ?? null,
    previousLine: options.previousLine ?? null,
    questionChanged: options.questionChanged ?? false,
    names,
    minVoices,
    moderation: { line: moderation, dissent: moderation },
  });
  const accept = (
    output: NonNullable<ModelResult["output"]>,
    mapping: ReadonlyMap<string, string>,
    moderation: OutputModeration,
    ignorePrevious = false,
  ) => {
    const verifyStart = clock.now();
    const verified = verifyLine(output, {
      ...context(mapping, moderation),
      ...(ignorePrevious ? { previousLine: null } : {}),
    });
    result.latency.verification += clock.now() - verifyStart;
    options.onVerification?.({
      kind: ignorePrevious ? "fallback" : "generation",
      attempt: result.attempts,
      ok: verified.ok,
      failures: [...verified.failures],
      line: output.line,
      dissent: output.dissent_line,
      offendingTokens: verified.offendingTokens,
    });
    if (verified.ok) {
      const keys = output.cited_cluster_ids.map((id) => mapping.get(id) ?? "");
      result.status = "verified";
      result.line = verified.line;
      result.dissent = verified.dissent;
      result.citedAuthors = verified.citedAuthors;
      result.pct = verified.pct;
      result.citedClusterKeys = keys;
      result.citedNames = [
        ...new Set(
          clusters
            .filter((cluster) => keys.includes(cluster.key))
            .flatMap((cluster) => cluster.names),
        ),
      ];
      result.mood = output.mood;
      result.answersQuestion = output.answers_question;
    }
    return verified;
  };
  let reason: RuleCode = "model_error";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (aborted()) return finish("aborted", "aborted");
    const input = buildInput(
      window,
      clusters,
      options.question ?? null,
      attempt ? reason : undefined,
    );
    result.attempts++;
    let generated: ModelResult;
    try {
      generated = await options.model.generate(input, options.signal);
    } catch {
      usage.push({ source: "model", usage: null, serviceTier: tier, costUsd: null });
      reason = "model_error";
      break;
    }
    result.latency.model += generated.latencyMs;
    usage.push(...(generated.additionalUsage ?? []));
    usage.push({
      source: "model",
      usage: generated.usage,
      serviceTier: tier,
      costUsd: modelCost(generated.usage, tier),
    });
    if (aborted() || generated.failure === "aborted") return finish("aborted", "aborted");
    if (
      generated.failure &&
      ["model_timeout", "model_rate_limit", "model_error"].includes(generated.failure)
    ) {
      reason = generated.failure;
      break;
    }
    if (generated.inputModeration.status === "error")
      return finish("input_moderation", "moderation_error");
    if (generated.inputModeration.flagged) return finish("input_moderation", "input_moderation");
    if (generated.failure || !generated.output) {
      reason = generated.failure ?? "schema_invalid";
      continue;
    }
    const verified = accept(generated.output, input.mapping, generated.outputModeration);
    if (verified.ok) return finish(null, null);
    reason = verified.failures[0] ?? "schema_invalid";
  }
  if (aborted()) return finish("aborted", "aborted");
  options.onFallback?.();
  const fallback = fallbackLine(clusters, window.voices, {
    blocklist: options.blocklist,
    minVoices,
  });
  if ("reason" in fallback) return finish("verification", fallback.reason);
  const built = buildInput(window, clusters, options.question ?? null);
  const fallbackContext = {
    ...context(built.mapping, { status: "ok", flagged: false }),
    previousLine: null,
  };
  const preflight = verifyLine(fallback.output, fallbackContext);
  options.onVerification?.({
    kind: "fallback_preflight",
    attempt: result.attempts,
    ok: preflight.ok,
    failures: [...preflight.failures],
    line: fallback.output.line,
    dissent: fallback.output.dissent_line,
    offendingTokens: preflight.offendingTokens,
  });
  if (!preflight.ok) return finish("verification", preflight.failures[0] ?? reason);
  let outputResult: OutputModeration = { status: "error" };
  let outputUsage: CallUsage = {
    source: "output_moderation",
    usage: null,
    serviceTier: tier,
    costUsd: null,
  };
  try {
    const response = await options.outputModeration.moderate(
      [fallback.output.line],
      options.signal,
    );
    outputUsage = { ...outputUsage, usage: response.usage, costUsd: response.costUsd ?? null };
    const item = response.results[0];
    if (response.results.length === 1 && item && typeof item.flagged === "boolean") {
      outputResult = {
        status: "ok",
        flagged: item.flagged || Object.values(item.categories).some(Boolean),
      };
    }
  } catch {
    /* The fallback is suppressed if output moderation is unavailable. */
  } finally {
    usage.push(outputUsage);
  }
  if (aborted()) return finish("aborted", "aborted");
  const verified = verifyLine(fallback.output, {
    ...fallbackContext,
    moderation: { line: outputResult },
  });
  if (!verified.ok) {
    options.onVerification?.({
      kind: "fallback",
      attempt: result.attempts,
      ok: false,
      failures: [...verified.failures],
      line: fallback.output.line,
      dissent: fallback.output.dissent_line,
      offendingTokens: verified.offendingTokens,
    });
    return finish("output_moderation", verified.failures[0] ?? reason);
  }
  result.fallback = true;
  accept(fallback.output, built.mapping, outputResult, true);
  return finish(null, null);
}
