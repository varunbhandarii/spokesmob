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
  resolveOverlayLayout,
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
  mood: null,
  hype: null,
};

test("clip visuals contain no IDs or links and capture links belong only to the dock", () => {
  expect(serverOverlayMessageSchema.safeParse({ type: "event", kind: "clip" }).success).toBe(true);
  expect(
    serverOverlayMessageSchema.safeParse({
      type: "event",
      kind: "clip",
      url: "https://clips.twitch.tv/example",
    }).success,
  ).toBe(false);
  const activity = {
    type: "activity",
    kind: "clip",
    at: 1,
    text: "Clipped",
    url: "https://clips.twitch.tv/example",
  };
  expect(serverControlMessageSchema.safeParse(activity).success).toBe(true);
  expect(serverOverlayMessageSchema.safeParse(activity).success).toBe(false);
  expect(
    serverControlMessageSchema.safeParse({ ...activity, url: "https://example.com/" }).success,
  ).toBe(false);
});

test("vote events validate on both visual and control boundaries", () => {
  const events = [
    { type: "event", kind: "vote_begin", choices: ["gary", "milo"], durationS: 30 },
    { type: "event", kind: "vote_update", counts: [3, 2] },
    { type: "event", kind: "vote_end" },
  ];
  for (const schema of [serverOverlayMessageSchema, serverControlMessageSchema]) {
    for (const event of events) expect(schema.safeParse(event).success).toBe(true);
    expect(schema.safeParse({ ...events[0], choices: ["x".repeat(26), "milo"] }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...events[1], counts: [-1, 0] }).success).toBe(false);
    expect(schema.safeParse({ ...events[1], counts: [0.5, 0] }).success).toBe(false);
    expect(schema.safeParse({ ...events[2], text: "extra" }).success).toBe(false);
  }
});
const line = {
  dissentPct: null,
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
test("preview support stays on controls; reveal and channel remain overlay-only", () => {
  const preview = {
    type: "preview",
    take: 1,
    text: line.text,
    dissent: null,
    dissentPct: null,
    pct: 71,
    voices: 312,
    holdMs: 1000,
    quiet: false,
  };
  expect(serverControlMessageSchema.safeParse(preview).success).toBe(true);
  expect(serverOverlayMessageSchema.safeParse(preview).success).toBe(false);
  expect(serverOverlayMessageSchema.safeParse({ type: "reveal", take: 1 }).success).toBe(true);
  expect(serverControlMessageSchema.safeParse({ type: "reveal", take: 1 }).success).toBe(false);
  for (const dissentPct of [null, 0, 18, 100]) {
    expect(serverOverlayMessageSchema.safeParse({ ...line, dissentPct }).success).toBe(true);
    expect(serverControlMessageSchema.safeParse({ ...preview, dissentPct }).success).toBe(true);
  }
  for (const dissentPct of [-1, 101, 18.5, undefined]) {
    expect(serverOverlayMessageSchema.safeParse({ ...line, dissentPct }).success).toBe(false);
    expect(serverControlMessageSchema.safeParse({ ...preview, dissentPct }).success).toBe(false);
  }
  for (const channel of ["", "bad/name", "UpperCase", undefined])
    expect(
      serverOverlayMessageSchema.safeParse({
        type: "hello",
        role: "overlay",
        audio: false,
        channel,
        state,
      }).success,
    ).toBe(false);
});

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

test("visual snapshots retain effective mood and active train state across an overlay reload", () => {
  const visual = { ...state, mood: "hype", hype: { level: 4, shared: true } };
  const message = {
    type: "hello",
    role: "overlay",
    audio: true,
    channel: "spokesmob",
    state: visual,
  };
  expect(serverOverlayMessageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
  expect(beatViewSchema.safeParse({ ...visual, hype: { level: -1, shared: true } }).success).toBe(
    false,
  );
  for (const query of [null, "invalid"]) {
    expect(resolveOverlayLayout(query, "wide")).toBe("wide");
    expect(resolveOverlayLayout(query, "compact")).toBe("compact");
  }
  expect(resolveOverlayLayout("stage", "wide")).toBe("stage");
  expect(resolveOverlayLayout("stage", "compact")).toBe("stage");
});

test("name payload caps apply independently of author counts and reject oversized batches", () => {
  expect(
    serverOverlayMessageSchema.safeParse({
      type: "particles",
      names: Array(200).fill("a".repeat(50)),
    }).success,
  ).toBe(true);
  expect(
    serverOverlayMessageSchema.safeParse({
      ...line,
      voices: 300,
      citedNames: Array(40).fill("Viewer"),
    }).success,
  ).toBe(true);
  for (const value of [
    { type: "particles", names: Array(201).fill("Viewer") },
    { type: "particles", names: ["a".repeat(51)] },
    { ...line, citedNames: Array(41).fill("Viewer") },
    { ...line, citedNames: ["a".repeat(51)] },
  ])
    expect(serverOverlayMessageSchema.safeParse(value).success).toBe(false);
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
    { type: "hello", role: "overlay", audio: true, channel: "spokesmob", state },
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
