import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveBeatSettings } from "../../../../packages/core/src/beat-settings.js";
import { createBlocklist } from "../../../../packages/core/src/blocklist.js";
import { clearModeration, FakeModerationPort } from "../consensus/fakes.js";
import { StubConsensusModel } from "../consensus/stub-model.js";
import { createLogger } from "../log.js";
import { openStorage } from "../store/db.js";
import { migrate } from "../store/migrations.js";
import { createRepositories } from "../store/repositories.js";
import { SpendLedger } from "../store/spend.js";
import { TwitchBus } from "../twitch/bus.js";
import type { TwitchEvent } from "../twitch/events.js";
import { CommandRouter } from "./commands.js";
import { FakeVoice } from "./fakes.js";
import { ChatOutput } from "./output.js";
import { BeatRunner } from "./runner.js";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external network"));
});
afterEach(async () => {
  for (const stop of cleanups.splice(0)) await stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(moderation = new FakeModerationPort()) {
  const db = openStorage(":memory:");
  migrate(db);
  const store = createRepositories(db);
  const ledger = new SpendLedger(store.costLedger, "commands", 5);
  const bus = new TwitchBus();
  const voice = new FakeVoice();
  const sent: string[] = [];
  const announced: string[] = [];
  let unpins = 0;
  const output = new ChatOutput(
    {
      sendChatMessage: async ({ text }) => {
        sent.push(text);
        return { sent: true, messageId: "sample", dropReason: null, suppressed: false };
      },
      pinMessage: async () => {},
      getPin: async () => ({ message_id: "existing", broadcaster_id: "1" }),
      unpinMessage: async () => {
        unpins++;
      },
      sendAnnouncement: async (text) => {
        announced.push(text);
      },
    },
    createLogger("silent"),
  );
  const overlay: unknown[] = [];
  const blocklist = createBlocklist({ channelTerms: ["forbiddenfruit"] });
  const runner = new BeatRunner({
    bus,
    online: { snapshot: () => ({ known: true, online: true }), onChange: () => () => {} },
    store,
    ledger,
    settings: resolveBeatSettings(),
    sessionId: "commands",
    voice,
    output,
    model: new StubConsensusModel(),
    moderation,
    blocklist,
    clients: () => ({ audioConnected: true, audioActive: true, overlayConnected: true }),
    overlay: (message) => overlay.push(message),
    log: createLogger("silent"),
    paidModel: false,
    paidVoice: false,
  });
  const commands = new CommandRouter({
    runner,
    store,
    ledger,
    output,
    moderation,
    blocklist,
    bus,
    log: createLogger("silent"),
  });
  voice.onReport = (event) => runner.report(event);
  runner.start();
  cleanups.push(async () => {
    commands.stop();
    await runner.stop();
    db.close();
  });
  const chat = (
    text: string,
    role: "broadcaster" | "moderator" | "viewer" = "viewer",
    id = "12",
    mention = false,
  ) => {
    const event: Extract<TwitchEvent, { kind: "chat" }> = {
      kind: "chat",
      id: `message-${id}-${Date.now()}`,
      at: new Date().toISOString(),
      channelId: "1",
      self: role === "broadcaster",
      text,
      author: {
        id,
        name: "Viewer",
        login: "viewer",
        color: null,
        broadcaster: role === "broadcaster",
        moderator: role === "moderator",
        vip: false,
        subscriber: false,
      },
      fragments: mention
        ? [{ type: "mention", text: "@Viewer", userId: "12", userLogin: "viewer" }]
        : [{ type: "text", text }],
      messageType: "text",
    };
    bus.emit(event);
  };
  return {
    runner,
    commands,
    store,
    ledger,
    sent,
    announced,
    chat,
    voice,
    overlay,
    moderation,
    unpins: () => unpins,
  };
}
test("self broadcaster and moderator commands act once; ordinary viewers are silently ignored", async () => {
  const f = fixture();
  f.chat("!mob off", "viewer");
  expect(f.runner.state.gates.enabled).toBe(true);
  expect(f.sent).toEqual([]);
  f.chat("!mob off", "broadcaster");
  f.chat("!mob off", "broadcaster");
  expect(f.runner.state.step).toBe("off");
  expect(f.sent).toEqual(["Spokesmob off"]);
  f.chat("!mob on", "moderator");
  expect(f.runner.state.step).toBe("listening");
  expect(f.sent.at(-1)).toBe("Spokesmob on");
  f.chat("!mob mode demand", "broadcaster");
  f.chat("!mob mode demand", "broadcaster");
  expect(f.store.settings.get().mode).toBe("demand");
  expect(f.sent.filter((text) => text === "Spokesmob mode: demand")).toHaveLength(1);
  f.chat("!mob speak", "moderator");
  f.chat("!mob veto", "moderator");
  expect(f.sent).toHaveLength(3);
});
test("mute and kill cancel synchronously, unpin once and persist; off makes no muted post", async () => {
  const f = fixture();
  f.chat("blue", "viewer", "12");
  f.chat("blue", "viewer", "13");
  await vi.advanceTimersByTimeAsync(8500);
  expect(f.runner.state.step).toBe("preview");
  const cancellations = vi.spyOn(f.voice, "cancelAll");
  const result = f.commands.execute({ action: "mute" });
  expect(cancellations).toHaveBeenCalled();
  expect(f.runner.state.mutedUntil).toBe(308500);
  expect(f.store.settings.getSafety()).toMatchObject({ muted: true, killed: false });
  await result;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.unpins()).toBe(1);
  await f.commands.execute({ action: "kill" });
  await f.commands.execute({ action: "kill" });
  expect(f.store.settings.getSafety()).toEqual({ muted: true, killed: true, mutedUntil: null });
  await f.commands.execute({ action: "mute", minutes: 1 });
  await vi.advanceTimersByTimeAsync(61000);
  expect(f.runner.state.gates.killed).toBe(true);
  await f.commands.execute({ action: "unmute" });
  expect(f.store.settings.getSafety().muted).toBe(false);
  const mutedPosts = f.sent.filter((text) => text === "Spokesmob muted").length;
  await f.commands.execute({ action: "off" });
  expect(f.sent.filter((text) => text === "Spokesmob muted")).toHaveLength(mutedPosts);
});
test("gags use a fragment ID, invalidate an in-flight vote and persist until explicitly removed", async () => {
  const f = fixture();
  f.chat("blue", "viewer", "12");
  f.chat("blue", "viewer", "13");
  await vi.advanceTimersByTimeAsync(8500);
  f.chat("!mob gag @Viewer", "broadcaster", "1", true);
  expect(f.store.gags.list()).toEqual(["12"]);
  expect(f.runner.state.step).toBe("cooldown");
  expect(f.overlay).toContainEqual({ type: "particles_clear" });
  expect(f.store.beatLog.recent(1)[0]?.reason).toBe("gagged_user");
  f.chat("!mob gag @Viewer", "broadcaster", "1", true);
  expect(f.sent).toEqual(["Got it"]);
  f.chat("!mob ungag @Viewer", "broadcaster", "1", true);
  expect(f.store.gags.list()).toEqual([]);
  f.chat("!mob gag @Viewer", "moderator");
  expect(f.store.gags.list()).toEqual([]);
});
test("safe questions are moderated and announced once; clear prevents a late moderation result from restoring them", async () => {
  const f = fixture();
  expect(await f.commands.execute({ action: "question", question: "Name my cat" })).toEqual({
    ok: true,
    reason: null,
  });
  await f.commands.execute({ action: "question", question: "Name my cat" });
  expect(f.runner.view().question).toBe("Name my cat");
  expect(f.announced).toEqual(["The mob is deciding: Name my cat"]);
  for (const question of [
    "@Viewer",
    "https://example.com",
    "visit example.xyz",
    "forbiddenfruit",
    " ",
  ])
    expect((await f.commands.execute({ action: "question", question })).ok).toBe(false);
  expect(f.moderation.requests).toHaveLength(2);
  let complete!: (value: ReturnType<typeof clearModeration>[]) => void;
  const delayed = fixture(
    new FakeModerationPort(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    ),
  );
  const pending = delayed.commands.execute({ action: "question", question: "Pick a name" });
  await delayed.commands.execute({ action: "clear" });
  complete([clearModeration()]);
  expect((await pending).reason).toBe("question_replaced");
  expect(delayed.announced).toEqual([]);
  expect(delayed.runner.view().question).toBeNull();
});
test("question moderation fails closed on flags, missing items and service failure", async () => {
  for (const handler of [
    () => [{ ...clearModeration(), flagged: true }],
    () => [],
    () => {
      throw new Error("synthetic failure");
    },
  ]) {
    const f = fixture(new FakeModerationPort(handler));
    expect((await f.commands.execute({ action: "question", question: "Name my cat" })).ok).toBe(
      false,
    );
    expect(f.runner.view().question).toBeNull();
    expect(f.announced).toEqual([]);
  }
});
test("settings, layout and cap persist while the offline test switch remains session-only", async () => {
  const f = fixture();
  await f.commands.execute({
    action: "settings",
    changes: { minVoices: 1, holdMs: 750, spendCapUsd: 0 },
  });
  expect(f.runner.state.heldBy).toContain("capped");
  expect(f.ledger.totals().cap).toBe(0);
  await f.commands.execute({ action: "settings", changes: { spendCapUsd: 5 } });
  expect(f.runner.state.heldBy).not.toContain("capped");
  await f.commands.execute({ action: "layout", layout: "compact" });
  expect(f.store.settings.getLayout()).toBe("compact");
  await f.commands.execute({ action: "testOffline", enabled: true });
  expect(f.runner.view().testOffline).toBe(true);
  expect(JSON.stringify(f.store.settings.list())).not.toContain("testOffline");
  expect(f.store.settings.get()).toMatchObject({ minVoices: 1, holdMs: 750, spendCapUsd: 5 });
});
