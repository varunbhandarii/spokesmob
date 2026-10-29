import { z } from "zod";
import { type BeatSettings, type BeatSettingsPatch, beatModeSchema } from "./beat-settings.js";
import { MOODS, type Mood, type SynthesisResult } from "./types.js";

export const BEAT_STEPS = [
  "off",
  "listening",
  "synthesizing",
  "preview",
  "speaking",
  "cooldown",
  "held",
] as const;
export const beatStepSchema = z.enum(BEAT_STEPS);
export type BeatStep = z.infer<typeof beatStepSchema>;
export const heldReasonSchema = z.enum([
  "muted",
  "killed",
  "off",
  "offline",
  "capped",
  "no_audio_client",
  "overlay_inactive",
]);
export type HeldReason = z.infer<typeof heldReasonSchema>;
export const layoutSchema = z.enum(["wide", "stage", "compact"]);
export type Layout = z.infer<typeof layoutSchema>;
export const displayNameSchema = z.string().min(1).max(50);
export const hypeStateSchema = z.strictObject({
  level: z.number().int().nonnegative(),
  shared: z.boolean(),
});
export const questionSchema = z.string().max(100).nullable();
export const beatViewSchema = z.strictObject({
  step: beatStepSchema,
  mode: beatModeSchema,
  muted: z.boolean(),
  mutedUntil: z.number().nonnegative().nullable(),
  online: z.boolean(),
  testOffline: z.boolean(),
  capped: z.boolean(),
  heldBy: z.array(heldReasonSchema).refine((reasons) => new Set(reasons).size === reasons.length),
  question: questionSchema,
  layout: layoutSchema,
  mood: z.enum(MOODS).nullable(),
  hype: hypeStateSchema.nullable(),
});
export type BeatView = z.infer<typeof beatViewSchema>;

export const eventNoticeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("raid"),
    name: displayNameSchema,
    viewers: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.enum(["hype_begin", "hype_level", "hype_end"]),
    level: z.number().int().nonnegative(),
    shared: z.boolean(),
  }),
]);
export type EventNotice = z.infer<typeof eventNoticeSchema>;
export interface QueuedEventLine {
  id: string;
  at: number;
  notice: EventNotice & { kind: "raid" | "hype_begin" | "hype_level" };
  text: string;
}
export interface BeatLine {
  text: string;
  dissent: string | null;
  pct: number;
  voices: number;
  mood: Mood;
  question: string | null;
  answersQuestion: boolean;
  templated: boolean;
  citedNames: readonly string[];
  citedExemplars: readonly string[];
  raidName: string | null;
}
export type BeatVoiceChannel = "main" | "dissent";
export interface BeatVoice {
  take: number | null;
  status: "pending" | "ready" | "playing" | "ended" | "caption_only" | "cancelled";
}
export interface BeatWindow {
  id: number;
  startAt: number;
  voices: number;
  messages: number;
}
export type BeatTimerKind = "window" | "hold" | "reading" | "cooldown" | "mute" | "mood";
export interface BeatTimer {
  id: number;
  kind: BeatTimerKind;
  at: number;
}
export interface ActiveBeat {
  id: number;
  kind: "consensus" | "event";
  windowId: number | null;
  closedAt: number;
  line: BeatLine | null;
  main: BeatVoice;
  dissent: BeatVoice | null;
  holdUntil: number | null;
  mainEndedAt: number | null;
  output: "idle" | "sending" | "pinning";
  outcome: "spoken" | "caption_only" | null;
  reason: string | null;
  question: string | null;
}
export interface BeatGates {
  enabled: boolean;
  killed: boolean;
  online: boolean;
  testOffline: boolean;
  capped: boolean;
  audioConnected: boolean;
  audioActive: boolean;
  overlayConnected: boolean;
}
export interface BeatState extends BeatView {
  settings: BeatSettings;
  gates: BeatGates;
  collection: BeatWindow | null;
  current: ActiveBeat | null;
  queuedEvent: QueuedEventLine | null;
  timers: Readonly<Partial<Record<BeatTimerKind, BeatTimer>>>;
  cooldownUntil: number | null;
  previousLine: string | null;
  questionChanged: boolean;
  nextId: number;
  lastMood: Mood | null;
  raidHypeUntil: number | null;
}

export const beatLogStatusSchema = z.enum([
  "spoken",
  "caption_only",
  "suppressed",
  "vetoed",
  "muted",
  "blocked",
  "skipped",
]);
export type BeatLogStatus = z.infer<typeof beatLogStatusSchema>;
const ms = z.number().nonnegative().nullable();
const cost = z.number().nonnegative().nullable();
const dbfs = z.union([z.number(), z.literal("-Infinity")]);
export const voiceAttemptLogSchema = z.strictObject({
  channel: z.enum(["main", "dissent"]),
  take: z.number().int().nonnegative().max(0xffff_ffff),
  attempt: z.number().int().min(1).max(2),
  reason: z
    .enum([
      "refusal",
      "drift",
      "unusable_audio",
      "stall",
      "incomplete",
      "transport",
      "late",
      "cancelled",
    ])
    .nullable(),
  detail: z.string().nullable(),
  gateFailures: z.array(z.string()),
  transcriptGateChecked: z.boolean(),
  audioGateChecked: z.boolean(),
  rawAudioComplete: z.boolean(),
  ttfaMs: ms,
  completeMs: ms,
  similarity: z.number().min(0).max(1).nullable(),
  audioMetrics: z
    .strictObject({
      sampleRate: z.number().int().positive(),
      samples: z.number().int().nonnegative(),
      durationMs: z.number().nonnegative(),
      rmsDbfs: dbfs,
      peakDbfs: dbfs,
      frames: z.number().int().nonnegative(),
      activeFrames: z.number().int().nonnegative(),
      activeFrameRatio: z.number().min(0).max(1),
      activeRmsDbfs: dbfs,
      longestZeroRunMs: z.number().nonnegative(),
      leadingSilenceMs: z.number().nonnegative(),
      clippingRatio: z.number().min(0).max(1),
    })
    .nullable(),
  usage: z
    .strictObject({
      textInputTokens: z.number().int().nonnegative(),
      cachedTextInputTokens: z.number().int().nonnegative(),
      textOutputTokens: z.number().int().nonnegative(),
      audioOutputTokens: z.number().int().nonnegative(),
      reasoningTokens: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  costUsd: cost,
});
export const beatLogRecordSchema = z.strictObject({
  id: z.string().min(1),
  at: z.number().nonnegative(),
  kind: z.enum(["consensus", "event"]),
  mode: beatModeSchema,
  status: beatLogStatusSchema,
  gate: z.string().nullable(),
  reason: z.string().nullable(),
  line: z.string().nullable(),
  dissent: z.string().nullable(),
  pct: z.number().int().min(0).max(100),
  voices: z.number().int().nonnegative(),
  mood: z.enum(MOODS).nullable(),
  citedExemplars: z.array(z.string()),
  citedNames: z.array(displayNameSchema).max(40),
  latency: z.strictObject({
    assemblyMs: ms,
    clusteringMs: ms.optional(),
    moderationMs: ms,
    modelMs: ms,
    verifierMs: ms,
    holdMs: ms,
    voiceReadyMs: ms,
    preRollMs: ms,
  }),
  e2eMs: ms,
  voiceAttempts: z.array(voiceAttemptLogSchema),
  costUsd: cost,
  unknownCost: z.boolean(),
});
export type BeatLogRecord = z.infer<typeof beatLogRecordSchema>;

export type BeatEvent =
  | { type: "tick"; timer: BeatTimerKind; id: number }
  | { type: "windowReady"; windowId: number; voices: number; messages: number }
  | {
      type: "synthDone";
      beatId: number;
      result: SynthesisResult;
      citedExemplars: readonly string[];
    }
  | { type: "eventVerified"; beatId: number; line: BeatLine | null; reason: string | null }
  | { type: "voiceReady"; beatId: number; channel: BeatVoiceChannel; take: number }
  | { type: "voiceStarted"; beatId: number; channel: BeatVoiceChannel; take: number }
  | { type: "voiceEnded"; beatId: number; channel: BeatVoiceChannel; take: number }
  | { type: "captionOnly"; beatId: number; channel: BeatVoiceChannel; reason: string }
  | { type: "veto" | "unmute" | "kill" | "on" | "off" | "speak" }
  | { type: "mute"; minutes: number }
  | { type: "gate"; changes: Partial<BeatGates> }
  | { type: "event"; event: QueuedEventLine }
  | { type: "settings"; changes: BeatSettingsPatch }
  | { type: "question"; question: string | null }
  | { type: "layout"; layout: Layout }
  | { type: "notice"; notice: EventNotice }
  | { type: "invalidate"; reason: string }
  | { type: "pinDone"; beatId: number }
  | {
      type: "postDone";
      beatId: number;
      sent: boolean;
      messageId: string | null;
      dropReason: string | null;
    };

export type BeatEffect =
  | { type: "openWindow"; window: BeatWindow }
  | { type: "slideWindow"; windowId: number; startAt: number }
  | { type: "closeWindow"; windowId: number; nextWindow: BeatWindow | null; at: number }
  | {
      type: "synthesize";
      beatId: number;
      windowId: number;
      question: string | null;
      questionChanged: boolean;
      previousLine: string | null;
    }
  | { type: "verifyEvent"; beatId: number; event: QueuedEventLine }
  | { type: "abortSynthesis"; beatId: number | null }
  | { type: "preview"; beatId: number; line: BeatLine; holdMs: number; quiet: boolean }
  | { type: "prepareVoice"; beatId: number; line: BeatLine }
  | { type: "play"; beatId: number; channel: BeatVoiceChannel }
  | { type: "cancelVoice"; beatId: number | null; reason: string }
  | { type: "post"; beatId: number; line: BeatLine }
  | { type: "pin"; beatId: number; messageId: string; durationS: number }
  | { type: "unpin" }
  | { type: "announce"; question: string }
  | { type: "ack"; text: string }
  | { type: "persistSafety"; muted: boolean; mutedUntil: number | null; killed: boolean }
  | {
      type: "log";
      beat: ActiveBeat;
      at: number;
      status: BeatLogStatus;
      gate: string | null;
      reason: string | null;
    }
  | { type: "setTimer"; timer: BeatTimer }
  | { type: "emit"; name: "state" | "listening" | "line" | "veto"; beatId: number | null };
export interface BeatReduction {
  state: BeatState;
  effects: readonly BeatEffect[];
}

export const BEAT_TRANSITIONS = [
  { from: "off", to: "listening", when: "on and every gate clear" },
  { from: "off", to: "held", when: "on with a blocking gate" },
  {
    from: "listening",
    to: "synthesizing",
    when: "eligible window or demand speak or queued event",
  },
  { from: "listening", to: "listening", when: "too few voices at thirty seconds: slide" },
  { from: "synthesizing", to: "preview", when: "verified consensus or event line" },
  { from: "synthesizing", to: "cooldown", when: "suppressed" },
  { from: "preview", to: "speaking", when: "hold ended and main ready" },
  { from: "preview", to: "cooldown", when: "veto or main caption-only or quiet reading complete" },
  { from: "speaking", to: "speaking", when: "main ended and dissent pending or playing" },
  {
    from: "speaking",
    to: "cooldown",
    when: "unit and output settled or main caption-only or veto",
  },
  { from: "cooldown", to: "listening", when: "cooldown ended" },
  { from: "listening", to: "held", when: "blocking gate" },
  { from: "synthesizing", to: "held", when: "blocking gate: abort" },
  { from: "preview", to: "held", when: "blocking gate: cancel" },
  { from: "speaking", to: "held", when: "blocking gate: cancel" },
  { from: "cooldown", to: "held", when: "blocking gate" },
  { from: "held", to: "listening", when: "every gate clear" },
  ...["listening", "synthesizing", "preview", "speaking", "cooldown", "held"].map((from) => ({
    from: from as BeatStep,
    to: "off" as const,
    when: "off: cancel and stop collection",
  })),
] as const satisfies readonly { from: BeatStep; to: BeatStep; when: string }[];
