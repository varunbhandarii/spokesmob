import { z } from "zod";
import { beatModeSchema, beatSettingsPatchSchema } from "./beat-settings.js";
import {
  beatLogRecordSchema,
  beatViewSchema,
  displayNameSchema,
  eventNoticeSchema,
  type Layout,
  layoutSchema,
  questionSchema,
  voiceAttemptLogSchema,
} from "./beat-types.js";
import { MOODS } from "./types.js";

export const audioChannelSchema = z.enum(["main", "dissent"]);
export type AudioChannel = z.infer<typeof audioChannelSchema>;
export const takeIdSchema = z.number().int().nonnegative().max(0xffff_ffff);
export const prepareMessageSchema = z.strictObject({
  type: z.literal("prepare"),
  take: takeIdSchema,
  channel: audioChannelSchema,
  text: z.string().max(2000),
});
export const playMessageSchema = z.strictObject({
  type: z.literal("play"),
  take: takeIdSchema,
  durationMs: z.number().positive().max(30000),
});
export const stopMessageSchema = z.strictObject({
  type: z.literal("stop"),
  take: z.union([takeIdSchema, z.literal("all")]),
});
export const audioControlSchema = z.discriminatedUnion("type", [
  prepareMessageSchema,
  playMessageSchema,
  stopMessageSchema,
]);
export type AudioControl = z.infer<typeof audioControlSchema>;
export const playbackReportSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.enum(["started", "ended", "stopped"]), take: takeIdSchema }),
  z.strictObject({
    type: z.literal("played"),
    take: takeIdSchema,
    samples: z.number().int().nonnegative(),
  }),
]);
export type PlaybackReport = z.infer<typeof playbackReportSchema>;
export const voiceCheckCommandSchema = z.strictObject({
  type: z.literal("voice_command"),
  request: z.string().regex(/^[a-z0-9-]{1,64}$/),
  mode: z.enum(["tone", "say", "kill_test"]),
  text: z.string().min(1).max(500).optional(),
  dissent: z.boolean().optional(),
});
export type VoiceCheckCommand = z.infer<typeof voiceCheckCommandSchema>;

export const clientRoleSchema = z.enum(["overlay", "control"]);
export type ClientRole = z.infer<typeof clientRoleSchema>;
export const overlayHelloSchema = z.strictObject({
  type: z.literal("hello"),
  role: z.literal("overlay"),
  audio: z.boolean(),
  obs: z.boolean(),
});
export const controlHelloSchema = z.strictObject({
  type: z.literal("hello"),
  role: z.literal("control"),
});
export const activeMessageSchema = z.strictObject({
  type: z.literal("active"),
  active: z.boolean(),
});
export const controlActionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("vote"), a: z.string().max(500), b: z.string().max(500) }),
  z.strictObject({ action: z.enum(["on", "off", "speak", "veto", "unmute", "kill", "clear"]) }),
  z.strictObject({
    action: z.literal("mute"),
    minutes: z.number().int().min(1).max(60).optional(),
  }),
  z.strictObject({ action: z.literal("mode"), mode: beatModeSchema }),
  z.strictObject({ action: z.literal("question"), question: z.string().min(1).max(100) }),
  z.strictObject({ action: z.literal("settings"), changes: beatSettingsPatchSchema }),
  z.strictObject({ action: z.literal("testOffline"), enabled: z.boolean() }),
  z.strictObject({ action: z.literal("layout"), layout: layoutSchema }),
  z.strictObject({ action: z.enum(["gag", "ungag"]), userId: z.string().min(1) }),
]);
export type ControlAction = z.infer<typeof controlActionSchema>;
export const controlCommandSchema = z.strictObject({
  type: z.literal("command"),
  request: z.string().regex(/^[a-z0-9-]{1,64}$/),
  command: controlActionSchema,
});
export const overlayClientMessageSchema = z.union([
  overlayHelloSchema,
  activeMessageSchema,
  playbackReportSchema,
]);
export const controlClientMessageSchema = z.union([
  controlHelloSchema,
  controlCommandSchema,
  voiceCheckCommandSchema,
]);
export const clientMessageSchema = z.union([
  overlayClientMessageSchema,
  controlClientMessageSchema,
]);
export type OverlayClientMessage = z.infer<typeof overlayClientMessageSchema>;
export type ControlClientMessage = z.infer<typeof controlClientMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export const stateMessageSchema = z.strictObject({
  type: z.literal("state"),
  ...beatViewSchema.shape,
});
export const overlayHelloReplySchema = z.strictObject({
  type: z.literal("hello"),
  role: z.literal("overlay"),
  audio: z.boolean(),
  channel: z.string().regex(/^[a-z0-9_]{1,25}$/),
  state: beatViewSchema,
  simulatedVoice: z.boolean().optional(),
});
export const controlHelloReplySchema = z.strictObject({
  type: z.literal("hello"),
  role: z.literal("control"),
  audio: z.literal(false),
  state: beatViewSchema,
  simulatedVoice: z.boolean().optional(),
});
export const listeningMessageSchema = z.strictObject({
  type: z.literal("listening"),
  voices: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  windowMs: z.number().nonnegative().max(30000),
});
export const particlesMessageSchema = z.strictObject({
  type: z.literal("particles"),
  names: z.array(displayNameSchema).max(200),
});
export const particlesClearMessageSchema = z.strictObject({ type: z.literal("particles_clear") });
export const lineMessageSchema = z.strictObject({
  showAgreement: z.boolean().optional(),
  type: z.literal("line"),
  take: takeIdSchema,
  text: z.string().min(1).max(2000),
  pct: z.number().int().min(0).max(100),
  voices: z.number().int().nonnegative(),
  dissent: z.string().nullable(),
  dissentPct: z.number().int().min(0).max(100).nullable(),
  mood: z.enum(MOODS),
  question: questionSchema,
  answersQuestion: z.boolean(),
  templated: z.boolean(),
  citedNames: z.array(displayNameSchema).max(40),
  holdMs: z.number().int().min(500).max(3000),
  quiet: z.boolean(),
});
export const previewMessageSchema = z.strictObject({
  type: z.literal("preview"),
  take: takeIdSchema,
  text: z.string().min(1).max(2000),
  dissent: z.string().nullable(),
  dissentPct: z.number().int().min(0).max(100).nullable(),
  pct: z.number().int().min(0).max(100),
  voices: z.number().int().nonnegative(),
  holdMs: z.number().int().min(500).max(3000),
  quiet: z.boolean(),
});
export const revealMessageSchema = z.strictObject({
  type: z.literal("reveal"),
  take: takeIdSchema,
});
export const vetoMessageSchema = z.strictObject({ type: z.literal("veto"), take: takeIdSchema });
export const voteEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    type: z.literal("event"),
    kind: z.literal("vote_begin"),
    choices: z.tuple([z.string().min(1).max(25), z.string().min(1).max(25)]),
    durationS: z.literal(30),
  }),
  z.strictObject({
    type: z.literal("event"),
    kind: z.literal("vote_update"),
    counts: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  }),
  z.strictObject({ type: z.literal("event"), kind: z.literal("vote_end") }),
]);
export const eventMessageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ type: z.literal("event"), kind: z.literal("clip") }),
  eventNoticeSchema.options[0].extend({ type: z.literal("event") }),
  eventNoticeSchema.options[1].extend({ type: z.literal("event") }),
]);
export const costMessageSchema = z.strictObject({
  type: z.literal("cost"),
  usdSession: z.number().nonnegative(),
  usdHour: z.number().nonnegative(),
  cap: z.number().nonnegative(),
});
const realtimeHealthSchema = z.strictObject({
  ok: z.boolean(),
  sessionAgeS: z.number().nonnegative(),
  lastTtfaMs: z.number().nonnegative().nullable(),
  lastCompleteMs: z.number().nonnegative().nullable(),
});
export const healthMessageSchema = z.strictObject({
  type: z.literal("health"),
  twitchAuth: z.strictObject({ ok: z.boolean() }),
  eventSub: z.strictObject({ connected: z.boolean(), state: z.string() }),
  subscriptions: z.strictObject({
    enabled: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  realtime: z.strictObject({ main: realtimeHealthSchema, dissent: realtimeHealthSchema }),
  audioClient: z.strictObject({ connected: z.boolean(), active: z.boolean() }),
  e2eMs: z.number().nonnegative().nullable(),
});
export const activityMessageSchema = z.strictObject({
  type: z.literal("activity"),
  kind: z.enum(["clip", "vote"]),
  at: z.number().nonnegative(),
  text: z.string().max(2500),
  url: z
    .url()
    .regex(/^https:\/\/(?:clips\.twitch\.tv|(?:www\.)?twitch\.tv)\//u)
    .nullable(),
});
export const logMessageSchema = z.strictObject({
  type: z.literal("log"),
  row: beatLogRecordSchema,
});
export const commandResultSchema = z.strictObject({
  type: z.literal("result"),
  request: z.string().regex(/^[a-z0-9-]{1,64}$/),
  ok: z.boolean(),
  reason: z.string().nullable(),
});
export const voiceCheckResultSchema = z.strictObject({
  type: z.literal("voice_result"),
  request: z.string().regex(/^[a-z0-9-]{1,64}$/),
  data: z.strictObject({
    status: z.enum(["verified", "caption_only", "cancelled", "rejected"]),
    reason: z.string().optional(),
    take: takeIdSchema.optional(),
    channel: audioChannelSchema.optional(),
    attempts: z
      .array(
        voiceAttemptLogSchema
          .omit({ channel: true, take: true, attempt: true })
          .extend({ transcript: z.string().nullable() }),
      )
      .optional(),
    verifiedAtMs: z.number().nonnegative().nullable().optional(),
    durationMs: z.number().nonnegative().optional(),
    trim: z
      .strictObject({
        leadingMs: z.number().nonnegative(),
        trailingMs: z.number().nonnegative(),
        totalMs: z.number().nonnegative(),
      })
      .nullable()
      .optional(),
    playback: z.string().optional(),
    readyMs: z.number().nonnegative().optional(),
    playbackStartMs: z.number().nonnegative().nullable().optional(),
    silenceMs: z.number().nonnegative().nullable().optional(),
  }),
});
export const serverOverlayMessageSchema = z.union([
  overlayHelloReplySchema,
  stateMessageSchema,
  listeningMessageSchema,
  particlesMessageSchema,
  particlesClearMessageSchema,
  lineMessageSchema,
  revealMessageSchema,
  vetoMessageSchema,
  eventMessageSchema,
  voteEventSchema,
  audioControlSchema,
]);
export const serverControlMessageSchema = z.union([
  controlHelloReplySchema,
  activityMessageSchema,
  voteEventSchema,
  stateMessageSchema,
  previewMessageSchema,
  logMessageSchema,
  costMessageSchema,
  healthMessageSchema,
  commandResultSchema,
  voiceCheckResultSchema,
]);
export type StateMessage = z.infer<typeof stateMessageSchema>;
export type LineMessage = z.infer<typeof lineMessageSchema>;
export type OverlayMessage = z.infer<typeof serverOverlayMessageSchema>;
export type ControlMessage = z.infer<typeof serverControlMessageSchema>;

export function resolveOverlayLayout(queryLayout: string | null, stateLayout: Layout): Layout {
  const pinned = layoutSchema.safeParse(queryLayout);
  return pinned.success ? pinned.data : stateLayout;
}
