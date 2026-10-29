import { expect, test } from "vitest";
import { createBeatState, reduce } from "./beat.js";
import type { BeatSettingsPatch } from "./beat-settings.js";
import {
  BEAT_STEPS,
  type BeatEvent,
  type BeatGates,
  type BeatReduction,
  type BeatState,
  type BeatStep,
} from "./beat-types.js";
import type { SynthesisResult } from "./types.js";

const gates: Partial<BeatGates> = {
  online: true,
  audioConnected: true,
  audioActive: true,
  overlayConnected: true,
};
const synthesized = (dissent = true): SynthesisResult => ({
  status: "verified",
  line: "Some of chat says blue.",
  dissent: dissent ? "Some still say red." : null,
  citedClusterKeys: ["blue"],
  pct: 60,
  voices: 10,
  citedAuthors: ["a", "b"],
  citedNames: ["Viewer"],
  mood: "chill",
  answersQuestion: true,
  fallback: false,
  attempts: 1,
  gate: null,
  reason: null,
  latency: { assembly: 0, clustering: 0, inputModeration: 0, model: 1, verification: 0, total: 1 },
  usage: [],
  costUsd: null,
});
const types = (result: BeatReduction) => result.effects.map((effect) => effect.type);
const start = (settings: BeatSettingsPatch = {}, gate = gates) =>
  reduce(createBeatState({ settings, gates: gate }), { type: "on" }, 0).state;
const window = (state: BeatState, now = 8000, voices = 2) =>
  reduce(
    state,
    { type: "windowReady", windowId: state.collection?.id ?? 0, voices, messages: voices },
    now,
  );
function preview(settings: BeatSettingsPatch = {}, dissent = true) {
  const state = window(start(settings)).state;
  return reduce(
    state,
    {
      type: "synthDone",
      beatId: state.current?.id ?? 0,
      result: synthesized(dissent),
      citedExemplars: ["blue"],
    },
    8100,
  ).state;
}
function playing(settings: BeatSettingsPatch = {}, dissent = true) {
  let state = preview(settings, dissent);
  const beatId = state.current?.id ?? 0;
  state = reduce(state, { type: "voiceReady", beatId, channel: "main", take: 100 }, 8200).state;
  if (dissent)
    state = reduce(
      state,
      { type: "voiceReady", beatId, channel: "dissent", take: 101 },
      8201,
    ).state;
  return tick(state, "hold", 9100).state;
}
function tick(state: BeatState, timer: Extract<BeatEvent, { type: "tick" }>["timer"], now: number) {
  return reduce(state, { type: "tick", timer, id: state.timers[timer]?.id ?? 0 }, now);
}
function end(state: BeatState, channel: "main" | "dissent", now: number) {
  return reduce(
    state,
    {
      type: "voiceEnded",
      beatId: state.current?.id ?? 0,
      channel,
      take: state.current?.[channel]?.take ?? 0,
    },
    now,
  );
}
function atStep(step: BeatStep): BeatState {
  switch (step) {
    case "off":
      return createBeatState();
    case "listening":
      return start();
    case "synthesizing":
      return window(start()).state;
    case "preview":
      return preview();
    case "speaking":
      return playing();
    case "cooldown":
      return end(playing({ postLines: "off" }, false), "main", 10000).state;
    case "held":
      return start({}, { ...gates, online: false });
  }
}

test("complete spoken unit posts after dissent, pins only the confirmed send, then starts cooldown", () => {
  const state = playing();
  const main = end(state, "main", 10000);
  expect(main.state.step).toBe("speaking");
  expect(main.state.current?.dissent?.status).toBe("playing");
  expect(types(main)).toContain("play");
  expect(types(main)).not.toContain("post");
  expect(main.state.cooldownUntil).toBe(null);
  const unit = end(main.state, "dissent", 11000);
  expect(types(unit).filter((type) => type === "post")).toHaveLength(1);
  expect(types(unit)).not.toContain("pin");
  expect(unit.state.step).toBe("speaking");
  expect(unit.state.cooldownUntil).toBe(null);
  const beatId = unit.state.current?.id ?? 0;
  const sent = reduce(
    unit.state,
    { type: "postDone", beatId, sent: true, messageId: "message", dropReason: null },
    11100,
  );
  expect(sent.effects).toContainEqual({ type: "pin", beatId, messageId: "message", durationS: 60 });
  expect(sent.state.cooldownUntil).toBe(null);
  const pinned = reduce(sent.state, { type: "pinDone", beatId }, 11200);
  expect(pinned.state.step).toBe("cooldown");
  expect(pinned.state.cooldownUntil).toBe(13200);
  expect(pinned.effects.find((effect) => effect.type === "log")).toMatchObject({
    status: "spoken",
  });
  expect(tick(pinned.state, "cooldown", 13200).state.step).toBe("listening");
  expect(end(unit.state, "dissent", 11100).effects).toEqual([]);
});

test("veto during dissent cancels the whole unit, prevents post/pin and rejects late take callbacks", () => {
  const state = end(playing(), "main", 10000).state;
  const beatId = state.current?.id ?? 0;
  const result = reduce(state, { type: "veto" }, 10500);
  expect(types(result)).toContain("cancelVoice");
  expect(types(result)).not.toContain("post");
  expect(result.state.step).toBe("cooldown");
  expect(result.effects.find((effect) => effect.type === "log")).toMatchObject({
    status: "vetoed",
  });
  for (const event of [
    { type: "voiceEnded", beatId, channel: "dissent", take: 101 },
    { type: "postDone", beatId, sent: true, messageId: "late", dropReason: null },
    { type: "voiceReady", beatId, channel: "main", take: 999 },
  ] satisfies BeatEvent[])
    expect(reduce(result.state, event, 10600).effects).toEqual([]);
});

test.each(BEAT_STEPS)(
  "off from %s cancels both takes and aborts synthesis without post or muted acknowledgment",
  (step) => {
    const result = reduce(atStep(step), { type: "off" }, 20000);
    expect(result.state.step).toBe("off");
    expect(result.state.collection).toBe(null);
    expect(result.state.current).toBe(null);
    expect(types(result)).toContain("abortSynthesis");
    expect(types(result)).toContain("cancelVoice");
    expect(types(result)).not.toContain("post");
    expect(types(result)).not.toContain("pin");
    expect(types(result)).not.toContain("ack");
    expect(types(result)).not.toContain("unpin");
  },
);

test.each(BEAT_STEPS)("veto in %s either cancels an unposted unit or is a no-op", (step) => {
  const result = reduce(atStep(step), { type: "veto" }, 20000);
  if (step === "preview" || step === "speaking") {
    expect(result.state.step).toBe("cooldown");
    expect(types(result)).toContain("cancelVoice");
  } else expect(result.effects).toEqual([]);
  expect(types(result)).not.toContain("post");
});

test.each(
  BEAT_STEPS.flatMap((step) => (["mute", "kill"] as const).map((type) => ({ step, type }))),
)("$type from $step cancels, aborts, unpins and persists safety", ({ step, type }) => {
  const result = reduce(atStep(step), type === "mute" ? { type, minutes: 5 } : { type }, 20000);
  for (const expected of ["abortSynthesis", "cancelVoice", "unpin", "persistSafety", "ack"])
    expect(types(result)).toContain(expected);
  expect(result.state.muted).toBe(true);
  expect(result.state.mutedUntil).toBe(type === "kill" ? null : 320000);
  expect(result.state.step).toBe(step === "off" ? "off" : "held");
  expect(types(result)).not.toContain("post");
});

test.each(["listening", "synthesizing", "preview", "speaking", "cooldown"] as const)(
  "every safety gate blocks %s and resumes only once all reasons clear",
  (step) => {
    const state = atStep(step);
    for (const change of [
      { online: false },
      { capped: true },
      { audioConnected: false },
      { audioActive: false },
      { overlayConnected: false },
    ] satisfies Partial<BeatGates>[]) {
      const blocked = reduce(state, { type: "gate", changes: change }, 20000);
      expect(blocked.state.step).toBe("held");
      expect(blocked.state.heldBy.length).toBeGreaterThan(0);
      expect(types(blocked)).not.toContain("post");
      if (step !== "cooldown" && step !== "listening")
        expect(types(blocked)).toContain("cancelVoice");
    }
    const both = reduce(
      state,
      { type: "gate", changes: { online: false, capped: true } },
      20000,
    ).state;
    const still = reduce(both, { type: "gate", changes: { online: true } }, 20001).state;
    expect(still.step).toBe("held");
    expect(still.heldBy).toEqual(["capped"]);
    expect(reduce(still, { type: "gate", changes: { capped: false } }, 20002).state.step).toBe(
      "listening",
    );
  },
);

test("hold and voice readiness are independent gates and stale or early timers do nothing", () => {
  const state = preview({}, false);
  const early = tick(state, "hold", 9000);
  expect(early.effects).toEqual([]);
  const held = tick(state, "hold", 9100);
  expect(held.state.step).toBe("preview");
  const ready = reduce(
    held.state,
    { type: "voiceReady", beatId: state.current?.id ?? 0, channel: "main", take: 100 },
    9500,
  );
  expect(ready.state.step).toBe("speaking");
  expect(types(ready).filter((type) => type === "play")).toHaveLength(1);
  expect(
    reduce(
      ready.state,
      { type: "voiceReady", beatId: state.current?.id ?? 0, channel: "main", take: 100 },
      9501,
    ).effects,
  ).toEqual([]);
  expect(reduce(ready.state, { type: "tick", timer: "hold", id: -1 }, 9502).effects).toEqual([]);
});

test.each([false, true])(
  "main caption-only never posts; dissent caption-only still allows the spoken main (%s)",
  (failMain) => {
    let state = preview();
    const beatId = state.current?.id ?? 0;
    state = reduce(
      state,
      { type: "captionOnly", beatId, channel: failMain ? "main" : "dissent", reason: "drift" },
      8200,
    ).state;
    if (failMain) {
      const result = tick(state, "hold", 9100);
      expect(result.state.step).toBe("cooldown");
      expect(types(result)).not.toContain("post");
      expect(types(result)).toContain("cancelVoice");
      expect(result.effects.find((effect) => effect.type === "log")).toMatchObject({
        gate: "voice",
        reason: "drift",
      });
    } else {
      state = reduce(state, { type: "voiceReady", beatId, channel: "main", take: 100 }, 8300).state;
      const result = end(tick(state, "hold", 9100).state, "main", 10000);
      expect(result.effects.find((effect) => effect.type === "post")).toMatchObject({
        line: { dissent: "Some still say red." },
      });
    }
  },
);

test("main waits for a late dissent result before output and no-dissent output begins after main", () => {
  let state = preview();
  const beatId = state.current?.id ?? 0;
  state = reduce(state, { type: "voiceReady", beatId, channel: "main", take: 100 }, 8200).state;
  const main = end(tick(state, "hold", 9100).state, "main", 10000);
  expect(main.state.step).toBe("speaking");
  expect(types(main)).not.toContain("post");
  const failed = reduce(
    main.state,
    { type: "captionOnly", beatId, channel: "dissent", reason: "stall" },
    11000,
  );
  expect(types(failed)).toContain("post");
  expect(types(end(playing({}, false), "main", 10000))).toContain("post");
});

test.each([
  { sent: false, messageId: null, dropReason: "missing_response_entry" },
  { sent: false, messageId: null, dropReason: null },
  { sent: true, messageId: "message", dropReason: "opaque_drop" },
  { sent: true, messageId: null, dropReason: null },
])("unconfirmed or dropped send never pins or retries: %j", (send) => {
  const state = end(playing({}, false), "main", 10000).state;
  const result = reduce(
    state,
    { type: "postDone", beatId: state.current?.id ?? 0, ...send },
    10100,
  );
  expect(result.state.step).toBe("cooldown");
  expect(types(result)).not.toContain("pin");
  expect(types(result)).not.toContain("post");
});

test("quiet mode requires an overlay but no audio owner, waits hold plus reading time and can be vetoed", () => {
  const state = preview({ mode: "quiet" });
  expect(state.timers.hold).toBeUndefined();
  expect(state.timers.reading?.at).toBe(12100);
  const result = tick(state, "reading", 12100);
  expect(types(result)).toContain("post");
  expect(types(result)).not.toContain("play");
  expect(types(result)).not.toContain("prepareVoice");
  const silent = start({ mode: "quiet" }, { online: true, overlayConnected: true });
  expect(silent.step).toBe("listening");
  expect(
    reduce(silent, { type: "gate", changes: { overlayConnected: false } }, 1).state.heldBy,
  ).toEqual(["no_audio_client"]);
  expect(types(reduce(state, { type: "veto" }, 9000))).not.toContain("post");
});

test("demand uses a rolling view closed only by Speak now while Auto ignores Speak now", () => {
  const auto = window(start(), 1000).state;
  expect(reduce(auto, { type: "speak" }, 2000).effects).toEqual([]);
  const demand = window(start({ mode: "demand" }), 8000).state;
  expect(demand.step).toBe("listening");
  expect(reduce(demand, { type: "speak" }, 8001).state.step).toBe("synthesizing");
  const tooFew = start({ mode: "demand" });
  expect(types(reduce(tooFew, { type: "speak" }, 8001))).not.toContain("synthesize");
});

test("underfilled windows slide without closing and a replacement opens at the exact close time", () => {
  let state = start();
  state = tick(state, "window", 8000).state;
  expect(state.step).toBe("listening");
  const first = tick(state, "window", 30000);
  const slide = tick(first.state, "window", 30500);
  expect(slide.effects).toContainEqual({
    type: "slideWindow",
    windowId: state.collection?.id,
    startAt: 500,
  });
  expect(types(slide)).not.toContain("closeWindow");
  const ready = window(slide.state, 31000);
  expect(ready.state.collection?.startAt).toBe(31000);
  expect(ready.effects.find((effect) => effect.type === "closeWindow")).toMatchObject({
    at: 31000,
    nextWindow: { startAt: 31000 },
  });
});

test("an eligible continuous window closes immediately when cooldown ends, including zero cooldown", () => {
  for (const cooldownS of [0, 2]) {
    let state = playing({ cooldownS, postLines: "off" }, false);
    state = window(state, 16000).state;
    state = end(state, "main", 17000).state;
    expect(state.step).toBe("cooldown");
    const result = tick(state, "cooldown", 17000 + cooldownS * 1000);
    expect(result.state.step).toBe("synthesizing");
    expect(types(result)).toContain("closeWindow");
  }
});

test("event lines queue during speech, raid wins over hype, and templates bypass consensus", () => {
  const hype = {
    id: "hype",
    at: 10000,
    notice: { kind: "hype_level", level: 2, shared: false },
    text: "Hype train level two!",
  } as const;
  const raid = {
    id: "raid",
    at: 10001,
    notice: { kind: "raid", name: "Friendly", viewers: 20 },
    text: "Raiders from Friendly just joined the mob, twenty new voices.",
  } as const;
  let state = playing({ postLines: "off" }, false);
  state = reduce(state, { type: "event", event: hype }, 10000).state;
  state = reduce(state, { type: "event", event: raid }, 10001).state;
  state = reduce(state, { type: "event", event: { ...hype, at: 10002 } }, 10002).state;
  expect(state.queuedEvent?.id).toBe("raid");
  expect(state.step).toBe("speaking");
  state = end(state, "main", 11000).state;
  const free = tick(state, "cooldown", 13000);
  expect(types(free)).toContain("verifyEvent");
  expect(types(free)).not.toContain("synthesize");
  expect(free.state.collection).not.toBe(null);
  const beatId = free.state.current?.id ?? 0;
  let eventState = reduce(
    free.state,
    {
      type: "eventVerified",
      beatId,
      reason: null,
      line: {
        text: raid.text,
        dissent: null,
        pct: 0,
        voices: 0,
        mood: "hype",
        question: null,
        answersQuestion: false,
        templated: true,
        citedNames: [],
        citedExemplars: [],
        raidName: "Friendly",
      },
    },
    13100,
  ).state;
  eventState = reduce(
    eventState,
    { type: "voiceReady", beatId, channel: "main", take: 200 },
    13200,
  ).state;
  expect(types(end(tick(eventState, "hold", 14100).state, "main", 15000))).not.toContain("post");
});

test("suppression and rejected templates log their gate and never prepare or post", () => {
  const state = window(start()).state;
  const result = reduce(
    state,
    {
      type: "synthDone",
      beatId: state.current?.id ?? 0,
      result: {
        ...synthesized(),
        status: "suppressed",
        reason: "input_moderation",
        gate: "input_moderation",
      },
      citedExemplars: [],
    },
    8100,
  );
  expect(result.effects.find((effect) => effect.type === "log")).toMatchObject({
    status: "suppressed",
    gate: "input_moderation",
  });
  expect(types(result)).not.toContain("prepareVoice");
  expect(types(result)).not.toContain("post");
  const waiting = reduce(
    start(),
    {
      type: "event",
      event: {
        id: "raid",
        at: 1000,
        notice: { kind: "raid", name: "Friendly", viewers: 10 },
        text: "Raiders just joined the mob.",
      },
    },
    1000,
  ).state;
  const rejected = reduce(
    waiting,
    { type: "eventVerified", beatId: waiting.current?.id ?? 0, line: null, reason: "blocked_term" },
    1100,
  );
  expect(rejected.effects.find((effect) => effect.type === "log")).toMatchObject({
    status: "suppressed",
    gate: "verification",
    reason: "blocked_term",
  });
  expect(types(rejected)).not.toContain("prepareVoice");
  expect(types(rejected)).not.toContain("post");
});

test("mood and hype persist in snapshots, overrides expire, and the session test switch is explicit", () => {
  let state = preview();
  expect(state.mood).toBe("chill");
  state = reduce(
    state,
    { type: "notice", notice: { kind: "raid", name: "Friendly", viewers: 10 } },
    9000,
  ).state;
  expect(state.mood).toBe("hype");
  state = reduce(
    state,
    { type: "notice", notice: { kind: "hype_begin", level: 1, shared: true } },
    10000,
  ).state;
  expect(state.hype).toEqual({ level: 1, shared: true });
  state = tick(state, "mood", 39000).state;
  expect(state.mood).toBe("hype");
  state = reduce(
    state,
    { type: "notice", notice: { kind: "hype_end", level: 1, shared: true } },
    40000,
  ).state;
  expect(state.hype).toBe(null);
  expect(state.mood).toBe("chill");
  expect(reduce(state, { type: "layout", layout: "compact" }, 40001).state.layout).toBe("compact");
  const held = start({}, { ...gates, online: false });
  expect(held.step).toBe("held");
  expect(reduce(held, { type: "gate", changes: { testOffline: true } }, 1).state.step).toBe(
    "listening",
  );
  expect(createBeatState().testOffline).toBe(false);
});

test("mute expiry uses the current timer identity and kill persists until explicit unmute", () => {
  const muted = reduce(start(), { type: "mute", minutes: 1 }, 1000).state;
  const extended = reduce(muted, { type: "mute", minutes: 2 }, 2000).state;
  expect(
    reduce(extended, { type: "tick", timer: "mute", id: muted.timers.mute?.id ?? 0 }, 61000)
      .effects,
  ).toEqual([]);
  expect(tick(extended, "mute", 122000).state.muted).toBe(false);
  const killed = reduce(extended, { type: "kill" }, 3000).state;
  expect(killed.timers.mute).toBeUndefined();
  expect(reduce(killed, { type: "unmute" }, 500000).state.step).toBe("listening");
});

test("the reducer is deterministic and never mutates a frozen input state", () => {
  function freeze<T extends object>(value: T): Readonly<T> {
    for (const item of Object.values(value)) if (item && typeof item === "object") freeze(item);
    return Object.freeze(value);
  }
  const input = freeze(playing());
  const event: BeatEvent = {
    type: "voiceEnded",
    beatId: input.current?.id ?? 0,
    channel: "main",
    take: 100,
  };
  expect(reduce(input, event, 10000)).toEqual(reduce(input, event, 10000));
  expect(input.current?.main.status).toBe("playing");
});
