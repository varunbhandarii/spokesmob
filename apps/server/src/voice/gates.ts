import {
  type AudioMetrics,
  analyzeAudio,
  decodePcm16LE,
} from "../../../../packages/core/src/audio.js";
import { trimVerifiedAudio } from "../../../../packages/core/src/audio-trim.js";
import {
  normalizeSpoken,
  similarity,
  spokenWordCount,
} from "../../../../packages/core/src/transcript.js";
import { VOICE_THRESHOLDS as T } from "../../../../packages/core/src/voice-thresholds.js";
import type { VoiceChannel } from "./types.js";

export function checkUsableAudio(
  rawPcm: Uint8Array,
  line: string,
): { ok: boolean; metrics: AudioMetrics | null; failures: string[] } {
  let metrics: AudioMetrics;
  try {
    metrics = analyzeAudio(decodePcm16LE(rawPcm), T.SAMPLE_RATE, T.ACTIVITY_RMS_FLOOR_DBFS);
  } catch {
    return { ok: false, metrics: null, failures: ["format"] };
  }
  const words = spokenWordCount(line);
  const perWord = words ? metrics.durationMs / words : 0;
  const checks: [string, boolean][] = [
    ["peak", metrics.peakDbfs >= T.MIN_PEAK_DBFS],
    ["active_ratio", metrics.activeFrameRatio >= T.MIN_ACTIVE_FRAME_RATIO],
    ["active_rms", metrics.activeRmsDbfs >= T.MIN_ACTIVE_RMS_DBFS],
    ["zero_run", metrics.longestZeroRunMs <= T.MAX_ZERO_RUN_MS],
    ["leading_silence", metrics.leadingSilenceMs <= T.MAX_LEADING_SILENCE_MS],
    [
      "duration",
      words > 0 &&
        metrics.durationMs >= T.MIN_DURATION_MS &&
        metrics.durationMs <= T.MAX_DURATION_MS &&
        perWord >= T.MIN_MS_PER_WORD &&
        perWord <= T.MAX_MS_PER_WORD,
    ],
  ];
  const failures = checks.filter(([, ok]) => !ok).map(([code]) => code);
  return { ok: failures.length === 0, metrics, failures };
}
export function checkTranscript(
  line: string,
  transcript: string,
): { ok: boolean; similarity: number } {
  const score = similarity(line, transcript);
  return {
    ok: !!normalizeSpoken(line) && !!normalizeSpoken(transcript) && score >= T.MIN_SIMILARITY,
    similarity: score,
  };
}
export function earlyPrefixCheck(line: string, transcript: string, elapsedMs: number) {
  const words = normalizeSpoken(transcript).split(" ").filter(Boolean);
  if (!words.length || (elapsedMs < T.EARLY_CHECK_MS && words.length < 3))
    return { checked: false, ok: true, similarity: null };
  const expected = normalizeSpoken(line).split(" ").slice(0, words.length).join(" ");
  const score = similarity(expected, words.join(" "));
  return { checked: true, ok: score >= T.EARLY_PREFIX_MIN, similarity: score };
}
export function verifyAndTrim(input: {
  rawPcm: Uint8Array;
  line: string;
  transcript: string;
  channel: VoiceChannel;
}) {
  // Mixer gain and filters belong to the overlay; both gates see original model data.
  const transcript = checkTranscript(input.line, input.transcript);
  const audio = checkUsableAudio(input.rawPcm, input.line);
  if (!transcript.ok || !audio.ok)
    return {
      ok: false as const,
      reason: !transcript.ok ? ("drift" as const) : ("unusable_audio" as const),
      similarity: transcript.similarity,
      audioMetrics: audio.metrics,
      failures: audio.failures,
    };
  const released = trimVerifiedAudio(input.rawPcm);
  return {
    ok: true as const,
    channel: input.channel,
    ...released,
    similarity: transcript.similarity,
    audioMetrics: audio.metrics,
  };
}
