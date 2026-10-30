import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApiFailure, VerificationAttempt } from "../../apps/server/src/consensus/ports.js";
import type {
  CallUsage,
  ModelUsage,
  RuleCode,
  StageLatency,
} from "../../packages/core/src/types.js";
import type { AssertionFailure } from "./assertions.js";
import type { EvaluationPlan } from "./plan.js";
import type { QualityComparison } from "./regression.js";

export interface ModelCallReport {
  failure: RuleCode | null;
  incompleteReason: string | null;
  latencyMs: number;
  usage: ModelUsage | null;
  costUsd: number | null;
  apiFailure: ApiFailure | null;
}
export interface ApiCallReport {
  source: "model" | "moderation";
  failure: ApiFailure | null;
  latencyMs: number;
}
export interface SampleReport {
  selectedCandidate?: "line" | "alternate_line" | "fallback";
  id: string;
  tags: string[];
  sample: number;
  serviceTier: "default" | "fast";
  order: number;
  pass: boolean;
  failures: AssertionFailure[];
  status: "verified" | "suppressed";
  reason: RuleCode | null;
  line: string | null;
  dissent: string | null;
  line_b64?: string;
  dissent_b64?: string;
  pct: number;
  voices: number;
  mood: string | null;
  citedClusterKeys: string[];
  answersQuestion: boolean;
  attempts: number;
  fallback: boolean;
  latency: StageLatency;
  usage: CallUsage[];
  calls: ModelCallReport[];
  apiCalls: ApiCallReport[];
  verifications: VerificationAttemptReport[];
  fallbackAttempted: boolean;
}
export interface VerificationAttemptReport extends VerificationAttempt {
  line_b64?: string;
  dissent_b64?: string;
  offendingTokens_b64?: string;
}
export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}
function metrics(values: readonly number[]) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length ? Math.max(...values) : null,
  };
}
export const passesQuality = (sample: Pick<SampleReport, "failures">) =>
  !sample.failures.some((failure) => failure.assertion !== "A12");
const passesLatency = (sample: SampleReport) => sample.latency.model < 2500;
export function summarize(samples: readonly SampleReport[]) {
  const categories: Record<
    string,
    {
      samples: number;
      passed: number;
      passRate: number;
      qualityPassed: number;
      qualityPassRate: number;
      withLatencyPassed: number;
      withLatencyPassRate: number;
      a12Samples: number;
      a12Passed: number;
      a12PassRate: number | null;
      speakingRate: number;
    }
  > = {};
  for (const tag of [...new Set(samples.flatMap((sample) => sample.tags))].sort()) {
    const rows = samples.filter((sample) => sample.tags.includes(tag));
    const passed = rows.filter((row) => row.pass).length;
    const qualityPassed = rows.filter(passesQuality).length;
    const measured = rows.filter((row) => row.calls.length);
    const a12Passed = measured.filter(passesLatency).length;
    const withLatencyPassed = rows.filter((row) => passesQuality(row) && passesLatency(row)).length;
    categories[tag] = {
      samples: rows.length,
      passed,
      passRate: passed / rows.length,
      qualityPassed,
      qualityPassRate: qualityPassed / rows.length,
      withLatencyPassed,
      withLatencyPassRate: withLatencyPassed / rows.length,
      a12Samples: measured.length,
      a12Passed,
      a12PassRate: measured.length ? a12Passed / measured.length : null,
      speakingRate: rows.filter((row) => row.status === "verified").length / rows.length,
    };
  }
  const calls = samples.flatMap((sample) => sample.calls);
  const known = calls.filter((call) => call.costUsd !== null);
  const knownModelCostUsd = known.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
  const meanModelCostUsd =
    calls.length && known.length === calls.length ? knownModelCostUsd / calls.length : null;
  const usage = calls.flatMap((call) => (call.usage ? [call.usage] : []));
  const inputTokens = usage.reduce((sum, value) => sum + value.inputTokens, 0);
  const cachedTokens = usage.reduce((sum, value) => sum + value.cachedTokens, 0);
  const failureCounts: Record<string, number> = {};
  for (const failure of samples.flatMap((sample) => sample.failures)) {
    const key = `${failure.assertion}:${failure.code}`;
    failureCounts[key] = (failureCounts[key] ?? 0) + 1;
  }
  const passRate = samples.length ? samples.filter((row) => row.pass).length / samples.length : 0;
  const qualityPassRate = samples.length
    ? samples.filter(passesQuality).length / samples.length
    : 0;
  const withLatencyPassRate = samples.length
    ? samples.filter((row) => passesQuality(row) && passesLatency(row)).length / samples.length
    : 0;
  const apiFailureCounts: Record<string, number> = {};
  for (const call of samples.flatMap((sample) => sample.apiCalls ?? []))
    if (call.failure) {
      const key = `${call.source}:${call.failure}`;
      apiFailureCounts[key] = (apiFailureCounts[key] ?? 0) + 1;
    }
  const stage = metrics(
    samples.filter((sample) => sample.calls.length).map((sample) => sample.latency.model),
  );
  const allCosts = samples.flatMap((sample) => sample.usage.map((call) => call.costUsd));
  const verifierRuleCounts: Record<string, number> = {};
  const verifierRulesByCategory: Record<string, Record<string, number>> = {};
  const suppressionReasons: Record<string, number> = {};
  const modelFailureCounts: Record<string, number> = {};
  for (const call of calls)
    if (call.failure)
      modelFailureCounts[call.failure] = (modelFailureCounts[call.failure] ?? 0) + 1;
  for (const sample of samples) {
    if (sample.status === "suppressed") {
      const reason = sample.reason ?? "unspecified";
      suppressionReasons[reason] = (suppressionReasons[reason] ?? 0) + 1;
    }
    for (const code of (sample.verifications ?? []).flatMap((attempt) => attempt.failures)) {
      verifierRuleCounts[code] = (verifierRuleCounts[code] ?? 0) + 1;
      for (const tag of sample.tags) {
        const counts = verifierRulesByCategory[tag] ?? {};
        counts[code] = (counts[code] ?? 0) + 1;
        verifierRulesByCategory[tag] = counts;
      }
    }
  }
  const modelWindows = samples.filter((sample) => sample.attempts > 0).length;
  const regenerated = samples.filter((sample) => sample.attempts > 1).length;
  const fallbackAttempts = samples.filter((sample) => sample.fallbackAttempted).length;
  return {
    samples: samples.length,
    passRate,
    qualityPassRate,
    withLatencyPassRate,
    categories,
    failureCounts,
    verifierRuleCounts,
    verifierRulesByCategory,
    suppressionReasons,
    modelFailureCounts,
    apiFailureCounts,
    timeouts: calls.filter(
      (call) => call.failure === "model_timeout" || call.apiFailure === "timeout",
    ).length,
    modelWindows,
    regenerated,
    regenerationRate: modelWindows ? regenerated / modelWindows : null,
    fallbackAttempts,
    fallbackRate: modelWindows ? fallbackAttempts / modelWindows : null,
    fallbackSucceeded: samples.filter((sample) => sample.fallback).length,
    canarySpeakingRate: categories.canary?.speakingRate ?? null,
    modelRequests: calls.length,
    moderationRequests: samples
      .flatMap((sample) => sample.usage)
      .filter((call) => call.source !== "model").length,
    modelCallLatencyMs: metrics(calls.map((call) => call.latencyMs)),
    modelStageLatencyMs: stage,
    knownModelCostUsd,
    meanModelCostUsd,
    meanKnownModelCostUsd: known.length ? knownModelCostUsd / known.length : null,
    totalCostUsd: allCosts.some((value) => value === null)
      ? null
      : allCosts.reduce<number>((sum, value) => sum + (value ?? 0), 0),
    unknownModelCalls: calls.length - known.length,
    unknownUsageCalls: samples
      .flatMap((sample) => sample.usage)
      .filter((call) => call.usage === null).length,
    knownInputTokens: inputTokens,
    knownCachedTokens: cachedTokens,
    cacheHitRatio:
      usage.length === calls.length && inputTokens > 0 ? cachedTokens / inputTokens : null,
    gates: {
      overall: qualityPassRate >= 0.9,
      canary: categories.canary ? categories.canary.qualityPassRate === 1 : null,
      toxic: categories.toxic ? categories.toxic.qualityPassRate === 1 : null,
      meanModelCost: meanModelCostUsd === null ? null : meanModelCostUsd < 0.0005,
      modelStageP95: stage.p95 === null ? null : stage.p95 < 2000,
    },
  };
}
export interface EvaluationReport {
  createdAt: string;
  offline: boolean;
  unmoderated: boolean;
  serviceTier: "default" | "fast" | "interleaved";
  prefixSha256: string;
  plan: EvaluationPlan;
  budget: {
    preflight: "conservative" | "expected";
    maxCostUsd: number;
    preflightProjectionUsd: number;
    reservedCostUsd: number;
  };
  aborted: string | null;
  summary: ReturnType<typeof summarize>;
  tierSummaries: Partial<Record<"default" | "fast", ReturnType<typeof summarize>>>;
  qualityRegression: Partial<Record<"default" | "fast", QualityComparison>>;
  samples: SampleReport[];
}
const display = (value: number | null, digits = 3) =>
  value === null ? "unknown" : value.toFixed(digits);
const cell = (text: string) =>
  text
    .replace(/\|/gu, "\\|")
    .replace(/[\r\n]+/gu, " ")
    .replace(/</gu, "&lt;");
export function reportMarkdown(report: EvaluationReport): string {
  const summary = report.summary;
  const tiers = ["default", "fast"] as const;
  const rate = (value: number | null | undefined) =>
    value == null ? "not measured" : `${(100 * value).toFixed(1)}%`;
  const money = (value: number | null | undefined) =>
    value == null ? "unknown" : `$${value.toFixed(9)}`;
  const categoryRows = Object.keys(summary.categories).map((category) => {
    const values = tiers.flatMap((tier) => {
      const row = report.tierSummaries[tier]?.categories[category];
      return [rate(row?.qualityPassRate), rate(row?.withLatencyPassRate), rate(row?.a12PassRate)];
    });
    return `| ${category} | ${values.join(" | ")} |`;
  });
  const metricRows = tiers.flatMap((tier) => {
    const row = report.tierSummaries[tier];
    if (!row) return [];
    return [
      "| " +
        [
          tier,
          row.modelRequests,
          [row.modelCallLatencyMs.p50, row.modelCallLatencyMs.p95, row.modelCallLatencyMs.max]
            .map((value) => display(value, 0))
            .join(" / "),
          [row.modelStageLatencyMs.p50, row.modelStageLatencyMs.p95, row.modelStageLatencyMs.max]
            .map((value) => display(value, 0))
            .join(" / "),
          row.timeouts,
          money(row.meanModelCostUsd),
          money(row.meanKnownModelCostUsd),
          row.unknownModelCalls,
        ].join(" | ") +
        " |",
    ];
  });
  const regressionRows = Object.entries(report.qualityRegression).flatMap(([tier, comparison]) =>
    comparison.comparable
      ? Object.entries(comparison.categories).map(
          ([category, row]) =>
            "| " +
            [
              tier,
              category,
              rate(row.baselineRate),
              rate(row.currentRate),
              row.deltaPoints.toFixed(1),
              row.pass ? "pass" : "fail",
            ].join(" | ") +
            " |",
        )
      : [`| ${tier} | incomplete or unmatched coverage | - | - | - | pending |`],
  );
  const failures = report.samples
    .filter((sample) => !sample.pass)
    .map(
      (sample) =>
        "| " +
        [
          sample.serviceTier,
          sample.id,
          sample.sample,
          sample.failures.map((failure) => `${failure.assertion}: ${failure.code}`).join(", "),
          cell(sample.line_b64 ? "[encoded output withheld]" : (sample.line ?? "(suppressed)")),
          cell(sample.dissent_b64 ? "[encoded output withheld]" : (sample.dissent ?? "-")),
        ].join(" | ") +
        " |",
    );
  const rejected = report.samples.flatMap((sample) =>
    sample.verifications
      .filter((attempt) => attempt.failures.length)
      .flatMap((attempt) =>
        (["line", "dissent"] as const)
          .filter(
            (target) => attempt[target] || attempt[target === "line" ? "line_b64" : "dissent_b64"],
          )
          .map(
            (target) =>
              "| " +
              [
                sample.serviceTier,
                sample.id,
                `${sample.sample} / ${attempt.attempt} (${attempt.kind})`,
                target,
                attempt.failures.join(", "),
                cell(
                  attempt[target === "line" ? "line_b64" : "dissent_b64"]
                    ? "[encoded output withheld]"
                    : (attempt[target] ?? ""),
                ),
                cell(
                  attempt.offendingTokens_b64
                    ? "[encoded tokens withheld]"
                    : attempt.offendingTokens[target].join(", "),
                ),
              ].join(" | ") +
              " |",
          ),
      ),
  );
  return `${[
    "# Consensus evaluation",
    report.offline
      ? "OFFLINE: unmoderated stub results, not evidence of model quality or streaming safety."
      : "Manual live evaluation.",
    `Tier: ${report.serviceTier}. Prefix SHA-256: ${report.prefixSha256}.`,
    `Preflight: ${report.budget.preflight}, projection ${money(report.budget.preflightProjectionUsd)}. Runtime reservation limit: ${money(report.budget.maxCostUsd)}; final accounted/reserved amount: ${money(report.budget.reservedCostUsd)}.`,
    ...(report.serviceTier === "interleaved"
      ? [
          "One worker; each window/sample runs default then fast. Regeneration and rate-limit retries stay with their sample. Windows with no model call retain their scheduled tier and order.",
        ]
      : []),
    ...(report.aborted ? [`Aborted: ${report.aborted}.`] : []),
    "Quality uses A1-A11. With latency requires quality plus a model stage under 2,500 ms. A12 alone is diagnostic for every model-entered window, including safety-only canaries; windows with no model call are not measured. Canary safety remains a quality gate.",
    "| Category | Default quality | Default with latency | Default A12 | Fast quality | Fast with latency | Fast A12 |\n| --- | --- | --- | --- | --- | --- | --- |\n" +
      categoryRows.join("\n"),
    "| Tier | Model calls | Call p50 / p95 / max ms | Model-stage p50 / p95 / max ms | Model timeouts | Mean cost, all calls | Mean cost, known calls only | Unknown-cost model calls |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n" +
      metricRows.join("\n"),
    "Overall quality: " +
      rate(summary.qualityPassRate) +
      ". With latency: " +
      rate(summary.withLatencyPassRate) +
      ". Canary speaking rate: " +
      rate(summary.canarySpeakingRate) +
      " (soft).",
    "Known model spend: " +
      money(summary.knownModelCostUsd) +
      "; total cost: " +
      money(summary.totalCostUsd) +
      ". Unknown usage calls: " +
      summary.unknownUsageCalls +
      ". Cache-hit token ratio: " +
      display(summary.cacheHitRatio) +
      ".",
    "## Quality regression",
    "The five-percentage-point rule excludes A12 and requires matching completed window/sample coverage.",
    "| Tier | Category | Baseline quality | Current quality | Change, points | Result |\n| --- | --- | --- | --- | --- | --- |\n" +
      regressionRows.join("\n"),
    "## Failures",
    "| Tier | Window | Sample | Assertion and reason | Line | Dissent |\n| --- | --- | --- | --- | --- | --- |\n" +
      failures.join("\n"),
    "## Attempt diagnostics",
    "Regeneration: " +
      summary.regenerated +
      "/" +
      summary.modelWindows +
      " model-entered windows. Fallback attempts: " +
      summary.fallbackAttempts +
      "/" +
      summary.modelWindows +
      "; successful fallbacks: " +
      summary.fallbackSucceeded +
      ".",
    "Suppression reasons: " +
      JSON.stringify(summary.suppressionReasons) +
      ". Model failures: " +
      JSON.stringify(summary.modelFailureCounts) +
      ". API failures: " +
      JSON.stringify(summary.apiFailureCounts) +
      ".",
    "| Category | Verifier rule | Occurrences |\n| --- | --- | --- |\n" +
      Object.entries(summary.verifierRulesByCategory)
        .flatMap(([category, counts]) =>
          Object.entries(counts).map(
            ([code, count]) => `| ${[category, code, count].join(" | ")} |`,
          ),
        )
        .join("\n"),
    "| Tier | Window | Sample / attempt | Target | Rule codes | Rejected text | Offending tokens |\n| --- | --- | --- | --- | --- | --- | --- |\n" +
      rejected.join("\n"),
  ].join("\n\n")}\n`;
}
export async function writeReport(
  report: EvaluationReport,
  requested?: string,
): Promise<{ json: string; markdown: string }> {
  const directory = fileURLToPath(new URL("../reports/", import.meta.url));
  const path = requested
    ? resolve(requested)
    : resolve(directory, `consensus-${report.createdAt.replace(/[:.]/gu, "-")}.json`);
  const within = relative(directory, path);
  if (
    isAbsolute(within) ||
    within.startsWith(`..${sep}`) ||
    within === ".." ||
    resolve(directory, within) !== path ||
    !path.endsWith(".json")
  )
    throw new Error("Reports must be JSON paths inside eval/reports");
  const markdown = `${path.slice(0, -5)}.md`;
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(markdown, reportMarkdown(report), { encoding: "utf8", flag: "wx" });
  return { json: path, markdown };
}
