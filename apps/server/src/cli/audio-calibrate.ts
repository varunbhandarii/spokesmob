import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  type AudioMetrics,
  analyzeAudio,
  decodePcm16LE,
} from "../../../../packages/core/src/audio.js";
import { readPcmWave } from "../audio/wav.js";

const manifestSchema = z.array(
  z.object({
    file: z
      .string()
      .min(1)
      .refine((value) => !/[/\\]/u.test(value)),
    words: z.number().int().positive(),
    normal: z.boolean(),
  }),
);
const serialize = (value: unknown, spaces?: number) =>
  JSON.stringify(
    value,
    (_, item: unknown) => (item === Number.NEGATIVE_INFINITY ? "-Infinity" : item),
    spaces,
  );
export interface AudioProposal {
  activityRmsFloorDbfs: number;
  minPeakDbfs: number;
  minActiveFrameRatio: number;
  minActiveRmsDbfs: number;
  maxZeroRunMs: number;
  maxLeadingSilenceMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  minMsPerWord: number;
  maxMsPerWord: number;
  expectedMsPerWord: number;
}
export interface CalibrationSample {
  file: string;
  words: number;
  normal: boolean;
  sha256: string;
  metrics: AudioMetrics;
  durationMsPerWord: number;
}
export function quantile(values: readonly number[], fraction: number): number {
  if (!values.length) throw new Error("No measurements");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? Number.NaN;
}
export function candidateFailures(sample: CalibrationSample, proposal: AudioProposal): string[] {
  const m = sample.metrics;
  const checks: [string, boolean][] = [
    ["peak", m.peakDbfs >= proposal.minPeakDbfs],
    ["active_ratio", m.activeFrameRatio >= proposal.minActiveFrameRatio],
    ["active_rms", m.activeRmsDbfs >= proposal.minActiveRmsDbfs],
    ["zero_run", m.longestZeroRunMs <= proposal.maxZeroRunMs],
    ["leading_silence", m.leadingSilenceMs <= proposal.maxLeadingSilenceMs],
    [
      "duration",
      m.durationMs >= proposal.minDurationMs &&
        m.durationMs <= proposal.maxDurationMs &&
        sample.durationMsPerWord >= proposal.minMsPerWord &&
        sample.durationMsPerWord <= proposal.maxMsPerWord,
    ],
  ];
  return checks.filter(([, pass]) => !pass).map(([code]) => code);
}

export function calibrationSummary(samples: CalibrationSample[], activityRmsFloorDbfs: number) {
  const normal = samples.filter((sample) => sample.normal);
  const negative = samples.filter((sample) => !sample.normal);
  if (!normal.length || !negative.length)
    throw new Error("Calibration needs normal and rejected references");
  const values = (key: keyof AudioMetrics) => normal.map((sample) => sample.metrics[key]);
  const minimum = (key: keyof AudioMetrics) => quantile(values(key), 0);
  const maximum = (key: keyof AudioMetrics) => quantile(values(key), 1);
  const msPerWord = normal.map((sample) => sample.durationMsPerWord);
  const proposal: AudioProposal = {
    activityRmsFloorDbfs,
    minPeakDbfs: Math.floor(minimum("peakDbfs") - 6),
    minActiveFrameRatio: Math.floor(minimum("activeFrameRatio") * 0.8 * 1000) / 1000,
    minActiveRmsDbfs: Math.floor(minimum("activeRmsDbfs") - 6),
    maxZeroRunMs: Math.ceil((maximum("longestZeroRunMs") + 250) / 50) * 50,
    maxLeadingSilenceMs: Math.ceil((maximum("leadingSilenceMs") + 200) / 50) * 50,
    minDurationMs: Math.floor((minimum("durationMs") * 0.75) / 25) * 25,
    maxDurationMs: Math.ceil((maximum("durationMs") * 1.25) / 100) * 100,
    minMsPerWord: Math.floor((quantile(msPerWord, 0) * 0.75) / 10) * 10,
    maxMsPerWord: Math.ceil((quantile(msPerWord, 1) * 1.25) / 10) * 10,
    expectedMsPerWord: Math.round(quantile(msPerWord, 0.5) / 25) * 25,
  };
  if (!Object.values(proposal).every(Number.isFinite))
    throw new Error("Normal references lack usable energy");
  const keys = [
    "durationMs",
    "peakDbfs",
    "rmsDbfs",
    "activeFrameRatio",
    "activeRmsDbfs",
    "longestZeroRunMs",
    "leadingSilenceMs",
    "clippingRatio",
  ] as const;
  const distribution = (numbers: number[]) => ({
    min: quantile(numbers, 0),
    p1: quantile(numbers, 0.01),
    p5: quantile(numbers, 0.05),
    median: quantile(numbers, 0.5),
    max: quantile(numbers, 1),
  });
  const metrics = Object.fromEntries(keys.map((key) => [key, distribution(values(key))]));
  metrics.durationMsPerWord = distribution(msPerWord);
  const normalFailures = normal.flatMap((sample) => {
    const failures = candidateFailures(sample, proposal);
    return failures.length ? [{ file: sample.file, failures }] : [];
  });
  const rejected = negative.map((sample) => ({
    file: sample.file,
    metrics: sample.metrics,
    failures: candidateFailures(sample, proposal),
  }));
  return {
    frameMs: 20,
    activityRmsFloorDbfs,
    normalCount: normal.length,
    rejectedCount: negative.length,
    metrics,
    proposal,
    normalFailures,
    rejected,
    proposalReady:
      normalFailures.length === 0 && rejected.every((sample) => sample.failures.length >= 2),
    samples,
  };
}

function inside(directory: string, path: string): boolean {
  const within = relative(directory, path);
  return (
    within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`))
  );
}
async function validateReportPath(directory: string, report: string): Promise<void> {
  if (!report.endsWith(".json") || inside(directory, report))
    throw new Error("Report must be JSON outside the read-only input folder");
  const repository = fileURLToPath(new URL("../../../../", import.meta.url));
  if (inside(repository, report)) {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", report], {
        cwd: repository,
        stdio: "ignore",
      });
    } catch {
      throw new Error("Calibration reports must stay untracked");
    }
  }
}
export async function calibrateAudio(options: {
  directory: string;
  manifest: string;
  report: string;
  activityRmsFloorDbfs?: number;
  output?: (line: string) => void;
}) {
  const directory = resolve(options.directory);
  const report = resolve(options.report);
  await validateReportPath(directory, report);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(options.manifest, "utf8")));
  const metadata = new Map(manifest.map((row) => [row.file, row]));
  if (metadata.size !== manifest.length) throw new Error("Duplicate audio metadata");
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".wav"))
    .map((entry) => entry.name)
    .sort();
  if (files.length !== metadata.size || files.some((file) => !metadata.has(file)))
    throw new Error("Every WAVE needs one metadata record");
  const floor = options.activityRmsFloorDbfs ?? -50;
  const samples: CalibrationSample[] = [];
  for (const file of files) {
    const row = metadata.get(file);
    if (!row) throw new Error("Missing metadata");
    const bytes = await readFile(resolve(directory, file));
    const wave = readPcmWave(bytes);
    const metrics = analyzeAudio(decodePcm16LE(wave.pcm), wave.sampleRate, floor);
    samples.push({
      ...row,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      metrics,
      durationMsPerWord: metrics.durationMs / row.words,
    });
  }
  const summary = calibrationSummary(samples, floor);
  await mkdir(dirname(report), { recursive: true });
  await writeFile(report, `${serialize(summary, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const output = options.output ?? console.log;
  output(
    `Normal ${summary.normalCount}; rejected references ${summary.rejectedCount}; frames 20 ms; activity floor ${floor} dBFS`,
  );
  output("Metric | min | p1 | p5 | median | max");
  for (const [key, value] of Object.entries(summary.metrics))
    output(
      `${key} | ${[value.min, value.p1, value.p5, value.median, value.max].map((number) => number.toFixed(4)).join(" | ")}`,
    );
  output(
    serialize({
      proposal: summary.proposal,
      normalFailures: summary.normalFailures,
      rejected: summary.rejected,
      proposalReady: summary.proposalReady,
      report,
    }),
  );
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      manifest: { type: "string" },
      report: { type: "string" },
      "activity-dbfs": { type: "string", default: "-50" },
    },
  });
  const directory = positionals[0];
  if (!directory || !values.manifest || !values.report) {
    console.error("Provide an audio folder, --manifest and a local --report JSON path.");
    process.exitCode = 1;
  } else {
    calibrateAudio({
      directory,
      manifest: values.manifest,
      report: values.report,
      activityRmsFloorDbfs: Number(values["activity-dbfs"]),
    })
      .then((summary) => {
        if (!summary.proposalReady) process.exitCode = 1;
      })
      .catch(() => {
        console.error(
          "Audio calibration failed; check input format, metadata and report destination.",
        );
        process.exitCode = 1;
      });
  }
}
