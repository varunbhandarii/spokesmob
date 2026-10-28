import { expect, test } from "vitest";
import {
  BEAT_STEPS,
  BEAT_TRANSITIONS,
  type BeatView,
  beatLogRecordSchema,
  beatViewSchema,
} from "./beat-types.js";
import {
  clientMessageSchema,
  controlClientMessageSchema,
  overlayClientMessageSchema,
  serverControlMessageSchema,
  serverOverlayMessageSchema,
  stateMessageSchema,
  voiceCheckResultSchema,
} from "./overlay-protocol.js";

const state: BeatView = {
  step: "off",
  mode: "auto",
  muted: false,
  mutedUntil: null,
  online: false,
  testOffline: false,
  capped: false,
  heldBy: ["off", "offline", "no_audio_client"],
  question: null,
  layout: "wide",
};
const line = {
  type: "line",
  take: 1,
  text: "Some of chat says blue.",
  pct: 40,
  voices: 10,
  dissent: null,
  mood: "chill",
  question: null,
  answersQuestion: false,
  templated: false,
  citedNames: ["Viewer"],
  holdMs: 1000,
  quiet: false,
};
const log = {
  id: "beat-1",
  at: 1000,
  kind: "consensus",
  mode: "auto",
  status: "spoken",
  gate: null,
  reason: null,
  line: line.text,
  dissent: null,
  pct: 40,
  voices: 10,
  mood: "chill",
  citedExemplars: ["blue"],
  citedNames: ["Viewer"],
  latency: {
    assemblyMs: 1,
    moderationMs: 1,
    modelMs: 600,
    verifierMs: 1,
    holdMs: 1000,
    voiceReadyMs: 700,
    preRollMs: 100,
  },
  e2eMs: 1703,
  voiceAttempts: [],
  costUsd: null,
  unknownCost: true,
};

test("all beat steps, layouts and multiple held reasons have one strict state contract", () => {
  expect(BEAT_STEPS).toEqual([
    "off",
    "listening",
    "synthesizing",
    "preview",
    "speaking",
    "cooldown",
    "held",
  ]);
  for (const step of BEAT_STEPS) {
    for (const layout of ["wide", "stage", "compact"]) {
      const value = { ...state, step, layout };
      expect(beatViewSchema.parse(value)).toEqual(value);
      expect(stateMessageSchema.parse({ type: "state", ...value })).toEqual({
        type: "state",
        ...value,
      });
    }
  }
  for (const value of [
    { ...state, step: "posting" },
    { ...state, heldBy: ["offline", "offline"] },
    { ...state, token: "synthetic" },
    { ...state, layout: "vertical" },
    { ...state, question: "a".repeat(101) },
  ])
    expect(beatViewSchema.safeParse(value).success).toBe(false);
});

test("the declared diagram covers every beat step and cancellation from active steps", () => {
  expect(new Set(BEAT_TRANSITIONS.flatMap(({ from, to }) => [from, to]))).toEqual(
    new Set(BEAT_STEPS),
  );
  for (const from of ["listening", "synthesizing", "preview", "speaking", "cooldown"] as const) {
    expect(BEAT_TRANSITIONS.some((row) => row.from === from && row.to === "held")).toBe(true);
    expect(BEAT_TRANSITIONS.some((row) => row.from === from && row.to === "off")).toBe(true);
  }
});

test("role-specific schemas separate overlay playback reports from control commands", () => {
  const overlayHello = { type: "hello", role: "overlay", audio: true, obs: true };
  const controlHello = { type: "hello", role: "control" };
  const voice = { type: "voice_command", request: "request-1", mode: "tone" };
  const command = {
    type: "command",
    request: "request-2",
    command: { action: "mute", minutes: 5 },
  };
  for (const value of [
    overlayHello,
    { type: "active", active: false },
    { type: "started", take: 1 },
    { type: "played", take: 1, samples: 24000 },
    { type: "ended", take: 1 },
    { type: "stopped", take: 1 },
  ]) {
    expect(overlayClientMessageSchema.safeParse(value).success).toBe(true);
    expect(controlClientMessageSchema.safeParse(value).success).toBe(false);
  }
  for (const value of [controlHello, voice, command]) {
    expect(controlClientMessageSchema.safeParse(value).success).toBe(true);
    expect(overlayClientMessageSchema.safeParse(value).success).toBe(false);
  }
  for (const value of [
    { type: "hello", audio: true, obs: true },
    { ...controlHello, audio: true },
    { ...overlayHello, role: "other" },
    {
      type: "command",
      request: "x",
      command: { action: "settings", changes: { testOffline: true } },
    },
  ]) {
    expect(clientMessageSchema.safeParse(value).success).toBe(false);
  }
});

test("overlay messages cover visuals and preserve every audio control shape", () => {
  for (const message of [
    { type: "hello", role: "overlay", audio: true, state },
    { type: "state", ...state },
    { type: "listening", voices: 2, messages: 4, windowMs: 8000 },
    { type: "particles", names: ["Viewer"] },
    { type: "particles_clear" },
    line,
    { type: "veto", take: 1 },
    { type: "event", kind: "raid", name: "Friendly Channel", viewers: 12 },
    { type: "event", kind: "hype_begin", level: 1, shared: false },
    { type: "event", kind: "hype_level", level: 2, shared: true },
    { type: "event", kind: "hype_end", level: 2, shared: true },
    { type: "prepare", take: 1, channel: "main", text: line.text },
    { type: "play", take: 1, durationMs: 1200 },
    { type: "stop", take: 1 },
    { type: "stop", take: "all" },
  ])
    expect(serverOverlayMessageSchema.parse(message)).toEqual(message);
  expect(serverOverlayMessageSchema.safeParse({ ...line, pct: 101 }).success).toBe(false);
  expect(serverOverlayMessageSchema.safeParse({ ...line, holdMs: 0 }).success).toBe(false);
  expect(
    serverOverlayMessageSchema.safeParse({ type: "event", kind: "raid", level: 1 }).success,
  ).toBe(false);
});

test("cost, health and logs are control-only and control replies cannot enable audio", () => {
  const realtime = { ok: true, sessionAgeS: 1, lastTtfaMs: null, lastCompleteMs: null };
  for (const message of [
    { type: "log", row: log },
    { type: "cost", usdSession: 0.01, usdHour: 0.02, cap: 5 },
    {
      type: "health",
      twitchAuth: { ok: true },
      eventSub: { connected: true, state: "ready" },
      subscriptions: { enabled: 9, total: 9 },
      realtime: { main: realtime, dissent: realtime },
      audioClient: { connected: true, active: true },
      e2eMs: 1703,
    },
  ]) {
    expect(serverControlMessageSchema.parse(message)).toEqual(message);
    expect(serverOverlayMessageSchema.safeParse(message).success).toBe(false);
  }
  expect(
    serverControlMessageSchema.safeParse({ type: "hello", role: "control", audio: false, state })
      .success,
  ).toBe(true);
  expect(
    serverControlMessageSchema.safeParse({ type: "hello", role: "control", audio: true, state })
      .success,
  ).toBe(false);
  expect(
    serverControlMessageSchema.safeParse({
      type: "prepare",
      take: 1,
      channel: "main",
      text: line.text,
    }).success,
  ).toBe(false);
  expect(beatLogRecordSchema.parse(log).costUsd).toBe(null);
  expect(beatLogRecordSchema.safeParse({ ...log, pcm: [1, 2] }).success).toBe(false);
  expect(
    voiceCheckResultSchema.safeParse({
      type: "voice_result",
      request: "x",
      data: { status: "rejected", reason: "audio_client_required" },
    }).success,
  ).toBe(true);
  expect(
    voiceCheckResultSchema.safeParse({
      type: "voice_result",
      request: "x",
      data: { status: "verified", pcm: [1, 2] },
    }).success,
  ).toBe(false);
});
