import type { AudioMetrics } from "../../../../packages/core/src/audio.js";
import type { TrimMetrics } from "../../../../packages/core/src/audio-trim.js";

export type VoiceChannel = "main" | "dissent";
export type VoiceFailure =
  | "refusal"
  | "drift"
  | "unusable_audio"
  | "stall"
  | "incomplete"
  | "transport"
  | "late"
  | "cancelled";
export interface VoiceUsage {
  textInputTokens: number;
  cachedTextInputTokens: number;
  textOutputTokens: number;
  audioOutputTokens: number;
  reasoningTokens: number | null;
}
export interface SessionAttempt {
  reason: VoiceFailure | null;
  detail: string | null;
  pcm: Uint8Array;
  transcript: string;
  audioMetrics: AudioMetrics | null;
  ttfaMs: number | null;
  completeMs: number | null;
  usage: VoiceUsage | null;
}
export interface VoiceAttemptRecord {
  reason: VoiceFailure | null;
  detail: string | null;
  transcript: string | null;
  gateFailures: string[];
  transcriptGateChecked: boolean;
  audioGateChecked: boolean;
  rawAudioComplete: boolean;
  ttfaMs: number | null;
  completeMs: number | null;
  similarity: number | null;
  audioMetrics: AudioMetrics | null;
  usage: VoiceUsage | null;
  costUsd: number | null;
}
export interface VoiceResult {
  take: number;
  channel: VoiceChannel;
  status: "verified" | "caption_only" | "cancelled";
  attempts: VoiceAttemptRecord[];
  verifiedAtMs: number | null;
  durationMs: number;
  trim: TrimMetrics | null;
}
