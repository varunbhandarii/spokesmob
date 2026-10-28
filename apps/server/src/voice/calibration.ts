import { createBlocklist } from "../../../../packages/core/src/blocklist.js";
import { verifyTemplated } from "../../../../packages/core/src/verify.js";
import type { ModerationPort } from "../consensus/ports.js";
import type { VoiceManager } from "./manager.js";
import type { VoiceResult } from "./types.js";

export interface CalibrationSample {
  index: number;
  text: string;
  readyMs: number;
  result: VoiceResult;
  playbackStartMs: null;
  releaseEligibleMs: number;
}
export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? null;
}
const stats = (values: number[]) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length ? Math.max(...values) : null,
});
const ratio = (rejected: number, evaluated: number) => ({
  rejected,
  evaluated,
  rate: evaluated ? rejected / evaluated : null,
});
export function calibrationReport(
  samples: CalibrationSample[],
  requested: number,
  aborted: string | null,
  budget: { limitUsd: number; reservedUsd: number },
) {
  const attempts = samples.flatMap((sample) => sample.result.attempts);
  const costs = attempts.map((attempt) => attempt.costUsd);
  const totalCostUsd = costs.some((cost) => cost === null)
    ? null
    : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const scores = attempts.flatMap((attempt) =>
    attempt.similarity === null ? [] : [attempt.similarity],
  );
  const latencies = (key: "ttfaMs" | "completeMs") =>
    attempts.flatMap((attempt) => (attempt[key] === null ? [] : [attempt[key] as number]));
  const trims = samples.flatMap((sample) => (sample.result.trim ? [sample.result.trim] : []));
  const usableRejected = attempts.filter((attempt) => attempt.reason === "unusable_audio").length;
  const transcriptRejected = attempts.filter((attempt) => attempt.reason === "drift").length;
  const summary = {
    requestedLines: requested,
    completedLines: samples.length,
    aborted,
    verified: samples.filter((sample) => sample.result.status === "verified").length,
    captionOnly: samples.filter((sample) => sample.result.status === "caption_only").length,
    attempts: attempts.length,
    firstAudioMs: stats(latencies("ttfaMs")),
    completeMs: stats(latencies("completeMs")),
    readyMs: stats(samples.map((sample) => sample.readyMs)),
    releaseEligibleMs: stats(samples.map((sample) => sample.releaseEligibleMs)),
    playbackMeasured: false,
    meanSimilarity: scores.length
      ? scores.reduce((sum, score) => sum + score, 0) / scores.length
      : null,
    minSimilarity: scores.length ? Math.min(...scores) : null,
    refusals: ratio(
      attempts.filter((attempt) => attempt.reason === "refusal").length,
      attempts.length,
    ),
    drift: ratio(transcriptRejected, attempts.length),
    usableAudioGate: ratio(
      usableRejected,
      attempts.filter((attempt) => attempt.audioGateChecked).length,
    ),
    transcriptGate: ratio(
      transcriptRejected,
      attempts.filter((attempt) => attempt.transcriptGateChecked).length,
    ),
    linesWithUsableAudioRejection: ratio(
      samples.filter((sample) =>
        sample.result.attempts.some((attempt) => attempt.reason === "unusable_audio"),
      ).length,
      samples.length,
    ),
    linesWithTranscriptRejection: ratio(
      samples.filter((sample) =>
        sample.result.attempts.some((attempt) => attempt.reason === "drift"),
      ).length,
      samples.length,
    ),
    leadingTrimMs: {
      median: percentile(
        trims.map((trim) => trim.leadingMs),
        0.5,
      ),
      max: trims.length ? Math.max(...trims.map((trim) => trim.leadingMs)) : null,
    },
    trailingTrimMs: {
      median: percentile(
        trims.map((trim) => trim.trailingMs),
        0.5,
      ),
      max: trims.length ? Math.max(...trims.map((trim) => trim.trailingMs)) : null,
    },
    totalCostUsd,
    knownCostUsd: costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
    unknownCostAttempts: costs.filter((cost) => cost === null).length,
    meanCostPerLineUsd:
      samples.length && totalCostUsd !== null ? totalCostUsd / samples.length : null,
    budget: {
      ...budget,
      consensusP95Ms: 1217,
      assemblyMs: 50,
      verifierMs: 10,
      preRollMs: 100,
      previewHoldMs: 1000,
      estimatedCloseToVerifiedAudioP95Ms: samples.length
        ? 50 +
          1217 +
          10 +
          Math.max(
            1000,
            percentile(
              samples.map((sample) => sample.readyMs),
              0.95,
            ) ?? 0,
          ) +
          100
        : null,
      inputModerationNotIncluded: true,
      estimateNotEndToEndMeasurement: true,
    },
  };
  const blocklist = createBlocklist();
  const protect = (text: string | null) =>
    text && blocklist.check(text).blocked
      ? { transcript: null, transcript_b64: Buffer.from(text).toString("base64") }
      : { transcript: text };
  const safeSamples = samples.map((sample) => ({
    ...sample,
    result: {
      ...sample.result,
      attempts: sample.result.attempts.map((attempt) => ({
        ...attempt,
        ...protect(attempt.transcript),
      })),
    },
  }));
  const rejected = safeSamples.flatMap((sample) =>
    sample.result.attempts.flatMap((attempt, index) =>
      attempt.reason && attempt.reason !== "cancelled"
        ? [
            {
              index: sample.index,
              text: sample.text,
              channel: sample.result.channel,
              attempt: index + 1,
              ...attempt,
            },
          ]
        : [],
    ),
  );
  return { summary, rejected, samples: safeSamples };
}
export type CalibrationReport = ReturnType<typeof calibrationReport>;
const cell = (text: string) =>
  text
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .replace(/</g, "&lt;");
export const serializeCalibration = (value: unknown) =>
  JSON.stringify(
    value,
    (_, item: unknown) => (item === Number.NEGATIVE_INFINITY ? "-Infinity" : item),
    2,
  );
export function calibrationMarkdown(report: CalibrationReport): string {
  const s = report.summary;
  const rows = report.rejected.map(
    (row) =>
      `| ${row.index} | ${row.channel} | ${row.attempt} | ${row.reason} / ${cell(row.detail ?? "")} | ${cell(row.transcript_b64 ? "[encoded transcript withheld]" : (row.transcript ?? "(unavailable)"))} | ${cell(serializeCalibration(row.audioMetrics))} | ${row.similarity ?? "unknown"} |`,
  );
  return `# Voice calibration\n\n${serializeCalibration(s)}\n\n## Rejected attempts\n\n| Line | Channel | Attempt | Reason | Transcript | Raw metrics | Similarity |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\nMetrics and gates use untrimmed raw model PCM. Partial audio is marked rawAudioComplete=false in JSON. Audio is never saved. Playback is unmeasured without an overlay; release-eligible timing includes the 1 s stand-in preview. The latency budget is a stage estimate, excludes pending input moderation, and is not a measured end-to-end p95.\n`;
}

export async function runVoiceCalibration(options: {
  count: number;
  lines: readonly string[];
  manager: VoiceManager;
  moderation: ModerationPort;
  now?: () => number;
  output?: (line: string) => void;
  budget: { limitUsd: number; reservedUsd: number };
}) {
  const now = options.now ?? Date.now;
  const samples: CalibrationSample[] = [];
  const blocklist = createBlocklist();
  let aborted: string | null = null;
  try {
    await options.manager.start();
    for (let index = 0; index < options.count; index++) {
      const line = options.lines[index % options.lines.length];
      if (!line || blocklist.check(line).blocked) {
        aborted = "line_blocked";
        break;
      }
      const moderation = await options.moderation.moderate([line]);
      const item = moderation.results[0];
      const gate = verifyTemplated(line, {
        blocklist,
        moderation:
          moderation.results.length === 1 && item
            ? {
                status: "ok",
                flagged: item.flagged || Object.values(item.categories).some(Boolean),
              }
            : { status: "error" },
      });
      if (!gate.ok) {
        aborted = gate.failures[0] ?? "output_moderation";
        break;
      }
      const start = now();
      const take = options.manager.prepare(line, index % 2 ? "dissent" : "main");
      const result = await take.ready;
      const readyMs = now() - start;
      samples.push({
        index: index + 1,
        text: line,
        readyMs,
        result: { ...result },
        playbackStartMs: null,
        releaseEligibleMs: Math.max(1000, readyMs),
      });
      options.output?.(
        JSON.stringify({
          kind: "voice_sample",
          index: index + 1,
          status: result.status,
          readyMs,
          attempts: result.attempts.length,
        }),
      );
      take.cancel("calibration_complete");
      if (result.attempts.some((attempt) => attempt.reason === "transport")) {
        aborted = "transport";
        break;
      }
      if (!result.attempts.length) {
        aborted = "cost_limit";
        break;
      }
    }
  } catch {
    aborted = "service_error";
  } finally {
    options.manager.close();
  }
  return calibrationReport(samples, options.count, aborted, options.budget);
}
