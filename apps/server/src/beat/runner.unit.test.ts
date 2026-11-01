import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveBeatSettings } from "../../../../packages/core/src/beat-settings.js";
import { createBlocklist } from "../../../../packages/core/src/blocklist.js";
import type {
  ControlMessage,
  OverlayMessage,
} from "../../../../packages/core/src/overlay-protocol.js";
import {
  serverControlMessageSchema,
  serverOverlayMessageSchema,
} from "../../../../packages/core/src/overlay-protocol.js";
import { type Clock, systemClock } from "../clock.js";
import {
  clearModeration,
  FakeConsensusModel,
  FakeModerationPort,
  fakeModelResult,
} from "../consensus/fakes.js";
import type { ModerationPort } from "../consensus/ports.js";
import { StubConsensusModel } from "../consensus/stub-model.js";
import { createLogger } from "../log.js";
import { openStorage } from "../store/db.js";
import { migrate } from "../store/migrations.js";
import { createRepositories } from "../store/repositories.js";
import { SpendLedger } from "../store/spend.js";
import { TwitchBus } from "../twitch/bus.js";
import type { TwitchEvent } from "../twitch/events.js";
import { FakeVoice } from "./fakes.js";
import { ChatOutput } from "./output.js";
import { BeatRunner } from "./runner.js";

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external network"));
});
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(
  options: {
    dissent?: boolean;
    quiet?: boolean;
    uncertain?: boolean;
    cap?: number;
    paidModel?: boolean;
    clock?: Clock;
    windowS?: number;
    alternate?: boolean;
    moderation?: ModerationPort;
    voiceReadyMs?: number;
  } = {},
) {
  const db = openStorage(":memory:");
  migrate(db);
  const store = createRepositories(db);
  const bus = new TwitchBus();
  const voice = new FakeVoice(systemClock, 1000, options.voiceReadyMs ?? 300);
  const calls: { action: string; at: number; text?: string; id?: string }[] = [];
  const output = new ChatOutput(
    {
      sendChatMessage: async ({ text }) => {
        calls.push({ action: "send", at: Date.now(), text });
        return {
          messageId: `message-${calls.length}`,
          sent: !options.uncertain,
          dropReason: options.uncertain ? "missing_response_entry" : null,
          suppressed: false,
        };
      },
      pinMessage: async (id) => {
        calls.push({ action: "pin", at: Date.now(), id });
      },
      getPin: async () => ({ message_id: "existing", broadcaster_id: "1" }),
      unpinMessage: async (id) => {
        calls.push({ action: "unpin", at: Date.now(), id });
      },
      sendAnnouncement: async (text) => {
        calls.push({ action: "announce", at: Date.now(), text });
      },
    },
    createLogger("silent"),
  );
  const overlay: OverlayMessage[] = [];
  const overlayAt: { message: OverlayMessage; at: number }[] = [];
  const controls: ControlMessage[] = [];
  const clips = { capture: vi.fn(async (_text: string) => undefined), stop: vi.fn() };
  const runner = new BeatRunner({
    clips,
    bus,
    online: { snapshot: () => ({ known: true, online: true }), onChange: () => () => undefined },
    store,
    ledger: new SpendLedger(store.costLedger, "sample", 5),
    settings: resolveBeatSettings({
      mode: options.quiet ? "quiet" : "auto",
      spendCapUsd: options.cap ?? 5,
      ...(options.windowS === undefined ? {} : { windowS: options.windowS }),
    }),
    sessionId: "sample",
    voice,
    output,
    model: options.alternate
      ? new FakeConsensusModel([
          fakeModelResult({
            line: "Chat wants blue.",
            alternate_line: "Chat says blue.",
            cited_cluster_ids: ["c1"],
            dissent_cluster_id: null,
            dissent_line: null,
            mood: "chill",
            answers_question: false,
          }),
        ])
      : options.dissent
        ? new FakeConsensusModel([
            fakeModelResult({
              line: "Some of chat says blue.",
              alternate_line: null,
              cited_cluster_ids: ["c1"],
              dissent_cluster_id: "c2",
              dissent_line: "Some of chat says red.",
              mood: "chill",
              answers_question: false,
            }),
          ])
        : new StubConsensusModel(),
    moderation: options.moderation ?? new FakeModerationPort(),
    blocklist: createBlocklist(),
    clients: () => ({ audioConnected: true, audioActive: true, overlayConnected: true }),
    overlay: (message) => {
      serverOverlayMessageSchema.parse(message);
      overlay.push(message);
      overlayAt.push({ message, at: Date.now() });
    },
    control: (message) => {
      serverControlMessageSchema.parse(message);
      controls.push(message);
    },
    log: createLogger("silent"),
    paidModel: options.paidModel ?? false,
    paidVoice: false,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  voice.onReport = (event) => runner.report(event);
  runner.start();
  cleanup.push(async () => {
    await runner.stop();
    db.close();
  });
  const chat = (id: string, text: string) => {
    const event: TwitchEvent = {
      kind: "chat",
      id,
      channelId: "1",
      at: new Date(Date.now()).toISOString(),
      self: false,
      author: {
        id,
        login: `viewer_${id}`,
        name: `Viewer ${id}`,
        color: null,
        broadcaster: false,
        moderator: false,
        vip: false,
        subscriber: false,
      },
      text,
      fragments: [{ type: "text", text }],
      messageType: "text",
    };
    bus.emit(event);
    return event;
  };
  return { clips, runner, store, voice, calls, overlay, overlayAt, controls, bus, chat };
}

test("the shell completes one verified unit, posts once, pins and records actual first-audio timing", async () => {
  const f = fixture();
  f.chat("one", "blue");
  f.chat("two", "blue");
  await vi.advanceTimersByTimeAsync(11000);
  expect(f.calls.map((call) => call.action)).toEqual(["send", "pin"]);
  expect(f.calls[0]?.at).toBeGreaterThanOrEqual(10100);
  expect(f.store.beatLog.recent(1)[0]).toMatchObject({
    status: "spoken",
    e2eMs: 1100,
    latency: { holdMs: 1000, voiceReadyMs: 300, preRollMs: 100 },
  });
  expect(f.overlay.some((message) => message.type === "line")).toBe(true);
});

test("window close while provisional moderation is pending still completes without a control action", async () => {
  let requests = 0;
  const f = fixture({
    windowS: 5,
    moderation: {
      async moderate(texts) {
        requests++;
        if (requests === 1) return new Promise(() => undefined);
        return { results: texts.map(clearModeration), usage: null, costUsd: 0 };
      },
    },
  });
  f.chat("one", "blue");
  f.chat("two", "blue");
  await vi.advanceTimersByTimeAsync(2000);
  expect(requests).toBe(1);
  await vi.advanceTimersByTimeAsync(6000);
  expect(f.store.beatLog.recent(1)[0]).toMatchObject({
    status: "spoken",
    gate: null,
    reason: null,
  });
  expect(f.calls.map((call) => call.action)).toEqual(["send", "pin"]);
  expect(requests).toBe(2);
});

test("the selected alternate reaches the caption, voice, chat post and confirmed pin", async () => {
  const f = fixture({ alternate: true });
  f.runner.state.previousLine = "Chat wants blue.";
  f.chat("one", "blue");
  f.chat("two", "blue");
  await vi.advanceTimersByTimeAsync(11000);
  expect(f.voice.prepared[0]?.text).toBe("Chat says blue.");
  expect(f.overlay.find((message) => message.type === "line")).toMatchObject({
    text: "Chat says blue.",
  });
  expect(f.calls).toEqual([
    expect.objectContaining({ action: "send", text: expect.stringContaining('"Chat says blue."') }),
    expect.objectContaining({ action: "pin", id: "message-1" }),
  ]);
  expect(f.store.beatLog.recent(1)[0]).toMatchObject({
    line: "Chat says blue.",
    selectedCandidate: "alternate_line",
    rejectedCandidates: [
      expect.objectContaining({ text: "Chat wants blue.", failures: ["near_duplicate"] }),
    ],
  });
});
test.each([false, true])(
  "a preview veto never reveals or plays in caption mode %s",
  async (quiet) => {
    const f = fixture({ quiet });
    f.chat("one", "blue");
    f.chat("two", "blue");
    await vi.advanceTimersByTimeAsync(8500);
    expect(f.controls.some((message) => message.type === "preview")).toBe(true);
    expect(f.overlay.some((message) => message.type === "reveal")).toBe(false);
    f.runner.dispatch({ type: "veto" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.voice.played).toEqual([]);
    expect(f.overlay.some((message) => message.type === "reveal")).toBe(false);
    expect(f.calls).toEqual([]);
  },
);
test.each([300, 2000])(
  "caption fallback reveals once after the hold with voice ready at %s ms",
  async (voiceReadyMs) => {
    const f = fixture({ voiceReadyMs });
    const original = f.voice.prepare.bind(f.voice);
    vi.spyOn(f.voice, "prepare").mockImplementation((text, channel) => {
      const take = original(text, channel);
      take.result.status = "caption_only";
      return take;
    });
    f.chat("one", "blue");
    f.chat("two", "blue");
    await vi.advanceTimersByTimeAsync(8999);
    expect(f.overlay.some((message) => message.type === "reveal")).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    const reveal = f.overlayAt.filter((row) => row.message.type === "reveal");
    expect(reveal).toHaveLength(1);
    expect(reveal[0]?.at).toBe(Math.max(9000, 8000 + voiceReadyMs));
    const lines = f.overlay.filter((message) => message.type === "line");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.take).toBeGreaterThan(lines[0]?.take ?? -1);
    expect(reveal[0]?.message).toMatchObject({ take: lines[1]?.take });
    expect(f.voice.played).toEqual([]);
    f.runner.dispatch({ type: "veto" });
    expect(
      f.overlay.at(-1)?.type === "veto" ||
        f.overlay.some((message) => message.type === "veto" && message.take === lines[1]?.take),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.overlay.filter((message) => message.type === "reveal")).toHaveLength(1);
    expect(f.calls).toEqual([]);
  },
);

test("window, hold and cooldown advance when every timeout wakes one millisecond early", async () => {
  const earlyAt: number[] = [];
  const clock: Clock = {
    ...systemClock,
    setTimeout: (callback, ms) =>
      setTimeout(
        () => {
          if (ms > 1) earlyAt.push(Date.now());
          callback();
        },
        Math.max(1, ms - 1),
      ),
  };
  // Keep the window deadline between collector polls so a poll cannot mask a lost tick.
  const f = fixture({ clock, windowS: 5.125 });
  const dispatch = vi.spyOn(f.runner, "dispatch");
  f.chat("one", "blue");
  f.chat("two", "blue");
  const window = f.runner.state.timers.window;
  expect(window?.at).toBe(5125);
  await vi.advanceTimersByTimeAsync(5124);
  expect(f.runner.state.step).toBe("listening");
  expect(f.runner.state.timers.window).toEqual(window);
  expect(
    dispatch.mock.calls.some(([event]) => event.type === "tick" && event.id === window?.id),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.runner.state.step).toBe("preview");
  const hold = f.runner.state.timers.hold;
  expect(hold?.at).toBe(6125);
  f.chat("three", "green");
  f.chat("four", "green");
  await vi.advanceTimersByTimeAsync(999);
  expect(f.runner.state.step).toBe("preview");
  expect(f.voice.played).toEqual([]);
  expect(
    dispatch.mock.calls.some(([event]) => event.type === "tick" && event.id === hold?.id),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.runner.state.step).toBe("speaking");
  await vi.advanceTimersByTimeAsync(1100);
  expect(f.runner.state.step).toBe("cooldown");
  const cooldown = f.runner.state.timers.cooldown;
  expect(cooldown?.at).toBe(9225);
  await vi.advanceTimersByTimeAsync(1999);
  expect(f.runner.state.step).toBe("cooldown");
  expect(
    dispatch.mock.calls.some(([event]) => event.type === "tick" && event.id === cooldown?.id),
  ).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.runner.state.step).toBe("listening");
  await vi.advanceTimersByTimeAsync(1025);
  expect(f.runner.state.step).toBe("preview");
  expect(earlyAt).toEqual(expect.arrayContaining([5124, 6124, 9224]));
  expect(f.calls.map((call) => call.action)).toEqual(["send", "pin"]);
});

test("a timed mute never expires early and cannot get stuck after an early wake", async () => {
  const clock: Clock = {
    ...systemClock,
    setTimeout: (callback, ms) => setTimeout(callback, Math.max(1, ms - 1)),
  };
  const f = fixture({ clock });
  f.runner.dispatch({ type: "mute", minutes: 1 });
  await vi.advanceTimersByTimeAsync(59999);
  expect(f.runner.view().muted).toBe(true);
  expect(f.store.settings.getSafety().muted).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.runner.view().muted).toBe(false);
  expect(f.runner.view().mutedUntil).toBeNull();
  expect(f.store.settings.getSafety().muted).toBe(false);
});
test("a veto during the dissent cancels both takes with no post and no pin", async () => {
  const f = fixture({ dissent: true });
  f.chat("one", "blue");
  f.chat("two", "blue");
  f.chat("three", "red");
  f.chat("four", "red");
  await vi.advanceTimersByTimeAsync(10500);
  expect(f.runner.state.step).toBe("speaking");
  expect(f.voice.played).toHaveLength(2);
  expect(f.calls).toEqual([]);
  f.runner.dispatch({ type: "veto" });
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.calls).toEqual([]);
  expect(f.store.beatLog.recent(1)[0]?.status).toBe("vetoed");
});
test("deleting a contributing message during preview clears particles and invalidates the unit", async () => {
  const f = fixture();
  const message = f.chat("one", "blue");
  f.chat("two", "blue");
  await vi.advanceTimersByTimeAsync(8500);
  f.bus.emit({
    kind: "chatDelete",
    at: new Date(Date.now()).toISOString(),
    channelId: "1",
    messageId: message.id,
    userId: message.author.id,
  });
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.calls).toEqual([]);
  expect(f.overlay.some((value) => value.type === "particles_clear")).toBe(true);
  expect(f.store.beatLog.recent(1)[0]).toMatchObject({
    status: "blocked",
    reason: "moderator_action",
  });
});
test("quiet preview can be vetoed and otherwise posts after the preview plus reading hold without preparing audio", async () => {
  const f = fixture({ quiet: true });
  f.chat("one", "blue");
  f.chat("two", "blue");
  await vi.advanceTimersByTimeAsync(8999);
  expect(f.overlay.some((message) => message.type === "reveal")).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const line = f.overlay.find((message) => message.type === "line");
  expect(f.overlay.filter((message) => message.type === "reveal")).toEqual([
    { type: "reveal", take: line?.take },
  ]);
  await vi.advanceTimersByTimeAsync(2999);
  expect(f.calls).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.calls.map((call) => call.action)).toEqual(["send", "pin"]);
  expect(f.voice.prepared).toEqual([]);
  expect(f.store.beatLog.recent(1)[0]).toMatchObject({ status: "caption_only", e2eMs: null });
});
test("mute cancels immediately, unpins, acknowledges once and keeps persisted safety armed", async () => {
  const f = fixture();
  f.chat("one", "blue");
  f.chat("two", "blue");
  await vi.advanceTimersByTimeAsync(9500);
  f.runner.dispatch({ type: "mute", minutes: 5 });
  expect(f.runner.state.step).toBe("held");
  expect(f.store.settings.getSafety().muted).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.calls.filter((call) => call.action === "send").map((call) => call.text)).toEqual([
    "Spokesmob muted",
  ]);
  expect(f.calls.some((call) => call.action === "unpin")).toBe(true);
});

test("an uncertain send is recorded without pinning or retrying", async () => {
  const f = fixture({ uncertain: true });
  f.chat("one", "blue");
  f.chat("two", "blue");
  await vi.advanceTimersByTimeAsync(11000);
  expect(f.calls.map((call) => call.action)).toEqual(["send"]);
  expect(f.store.beatLog.recent(1)[0]).toMatchObject({
    status: "spoken",
    gate: "chat",
    reason: "missing_response_entry",
  });
});
test("main caption-only never plays or posts and insufficient reservation room caps before the model call", async () => {
  const f = fixture();
  const original = f.voice.prepare.bind(f.voice);
  vi.spyOn(f.voice, "prepare").mockImplementation((text, channel) => {
    const take = original(text, channel);
    take.result.status = "caption_only";
    return take;
  });
  f.chat("one", "blue");
  f.chat("two", "blue");
  await vi.advanceTimersByTimeAsync(13000);
  expect(f.voice.played).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(f.store.beatLog.recent(1)[0]?.status).toBe("caption_only");
  const capped = fixture({ paidModel: true, cap: 0.0004 });
  capped.chat("first", "red");
  capped.chat("second", "red");
  await vi.advanceTimersByTimeAsync(8000);
  expect(capped.runner.state.heldBy).toContain("capped");
  expect(capped.voice.prepared).toEqual([]);
  expect(capped.calls).toEqual([]);
});

test.each([false, true])(
  "a completed shown unit arms laugh capture, with quiet=%s",
  async (quiet) => {
    const f = fixture({ quiet });
    f.chat("one", "blue");
    f.chat("two", "blue");
    await vi.advanceTimersByTimeAsync(13000);
    expect(f.store.beatLog.recent(1)[0]?.status).toBe(quiet ? "caption_only" : "spoken");
    for (let i = 0; i < 4; i++) f.chat(`laugh${i}`, "LUL");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.clips.capture).toHaveBeenCalledTimes(1);
    expect(f.clips.capture).toHaveBeenCalledWith(expect.stringContaining("blue"));
    for (let i = 0; i < 4; i++) f.chat(`later${i}`, "LUL");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.clips.capture).toHaveBeenCalledTimes(1);
  },
);
test("vetoed previews and muted completed lines cannot arm laugh capture", async () => {
  const f = fixture();
  f.chat("one", "blue");
  f.chat("two", "blue");
  await vi.advanceTimersByTimeAsync(8500);
  f.runner.dispatch({ type: "veto" });
  await vi.advanceTimersByTimeAsync(3000);
  for (let i = 0; i < 4; i++) f.chat(`laugh${i}`, "LUL");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.clips.capture).not.toHaveBeenCalled();
});

test.each(["mute", "kill", "off", "offline", "disabled"] as const)(
  "laugh capture is cleared or disabled by %s",
  async (action) => {
    const f = fixture();
    f.chat("one", "blue");
    f.chat("two", "blue");
    await vi.advanceTimersByTimeAsync(11000);
    if (action === "mute") f.runner.dispatch({ type: "mute", minutes: 1 });
    else if (action === "offline") f.runner.dispatch({ type: "gate", changes: { online: false } });
    else if (action === "disabled")
      f.runner.dispatch({ type: "settings", changes: { autoClip: false } });
    else f.runner.dispatch({ type: action });
    for (let i = 0; i < 4; i++) f.chat(`laugh${i}`, "LUL");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.clips.capture).not.toHaveBeenCalled();
  },
);
