import type { BeatLogRecord } from "../../../../packages/core/src/beat-types.js";
import type { MockCall } from "../../../../tools/mock-eventsub/src/services.js";
import type { BeatRunner } from "./runner.js";

export function distribution(values: readonly number[]) {
  const sorted = values
    .filter(Number.isFinite)
    .slice()
    .sort((a, b) => a - b);
  const at = (share: number) =>
    sorted.length ? (sorted[Math.ceil(sorted.length * share) - 1] ?? null) : null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? null };
}
export function loopReport(options: {
  rows: BeatLogRecord[];
  calls: readonly MockCall[];
  runner: BeatRunner;
  heap: readonly { atMs: number; bytes: number }[];
  elapsedMs: number;
  apiFailure: string | null;
}) {
  const { rows, runner, heap, calls } = options;
  const stages = [
    "assemblyMs",
    "clusteringMs",
    "moderationMs",
    "modelMs",
    "verifierMs",
    "holdMs",
    "voiceReadyMs",
    "preRollMs",
  ] as const;
  const outcomes: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  for (const row of rows) {
    outcomes[row.status] = (outcomes[row.status] ?? 0) + 1;
    if (row.reason) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  }
  return {
    kind: "loop_summary",
    elapsedMs: options.elapsedMs,
    simulated: rows.some((row) => row.simulated),
    apiFailure: options.apiFailure,
    beats: runner.records.begun,
    resolved: runner.resolvedBeats,
    pending: runner.pendingBeats,
    droppedBeats: runner.records.begun - runner.resolvedBeats - runner.pendingBeats,
    outcomes,
    reasons,
    posts: calls.filter((call) => call.path === "/helix/chat/messages" && call.method === "POST")
      .length,
    pins: calls.filter((call) => call.path === "/helix/chat/pins" && call.method === "PUT").length,
    e2eMs: distribution(rows.flatMap((row) => (row.e2eMs === null ? [] : [row.e2eMs]))),
    latencyMs: Object.fromEntries(
      stages.map((stage) => [
        stage,
        distribution(
          rows.flatMap((row) => {
            const value = row.latency[stage];
            return value === null || value === undefined ? [] : [value];
          }),
        ),
      ]),
    ),
    windowProcessingMs: distribution(runner.processingMs),
    listeningAssemblyMs: distribution(runner.collectionMs),
    beatCostUsd: rows.some((row) => row.unknownCost || row.costUsd === null)
      ? null
      : rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    unknownCostBeats: rows.filter((row) => row.unknownCost || row.costUsd === null).length,
    heap: {
      startBytes: heap[0]?.bytes ?? null,
      endBytes: heap.at(-1)?.bytes ?? null,
      samples: heap,
    },
  };
}
