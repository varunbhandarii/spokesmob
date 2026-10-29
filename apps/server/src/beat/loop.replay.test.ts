import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveBeatSettings } from "../../../../packages/core/src/beat-settings.js";
import { createBlocklist } from "../../../../packages/core/src/blocklist.js";
import type { OverlayMessage } from "../../../../packages/core/src/overlay-protocol.js";
import { generateScenario } from "../../../../tools/crowd-sim/src/generate.js";
import {
  expandScenario,
  parseScenario,
  type Scenario,
} from "../../../../tools/mock-eventsub/src/scenario.js";
import { createMockServices } from "../../../../tools/mock-eventsub/src/services.js";
import { loadConfig } from "../config.js";
import { FakeModerationPort } from "../consensus/fakes.js";
import { StubConsensusModel } from "../consensus/stub-model.js";
import { createLogger } from "../log.js";
import { openStorage } from "../store/db.js";
import { migrate } from "../store/migrations.js";
import { createRepositories } from "../store/repositories.js";
import { SpendLedger } from "../store/spend.js";
import { TwitchBus } from "../twitch/bus.js";
import { mapNotification } from "../twitch/events.js";
import { HelixClient } from "../twitch/helix.js";
import { StreamStatus } from "../twitch/online.js";
import { FakeVoice } from "./fakes.js";
import { ChatOutput } from "./output.js";
import { loopReport } from "./report.js";
import { BeatRunner } from "./runner.js";

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External network forbidden"));
});
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const log = createLogger("silent");
const load = async (name: string) =>
  parseScenario(
    await readFile(
      new URL(`../../../../tools/mock-eventsub/scenarios/${name}.jsonl`, import.meta.url),
      "utf8",
    ),
  );
async function fixture() {
  const config = loadConfig({
    TWITCH_CLIENT_ID: "mock-client",
    TWITCH_CLIENT_SECRET: "synthetic",
    TWITCH_CHANNEL: "spokesmob_demo",
    HELIX_URL: "http://mock/helix",
  });
  const services = createMockServices({ online: true });
  const helix = new HelixClient({
    config,
    log,
    channelId: services.user.id,
    fetch: services.fetch,
    auth: {
      identity: {
        userId: services.auth.userId,
        login: services.auth.login,
        scopes: services.auth.scopes,
        expiresAt: Date.now() + 3600000,
      },
      getAccessToken: async () => services.auth.accessToken,
      onUnauthorized: async () => services.auth.accessToken,
    },
  });
  const bus = new TwitchBus();
  const online = new StreamStatus({ helix, bus, channelId: services.user.id, log });
  await online.start();
  const db = openStorage(":memory:");
  migrate(db);
  const store = createRepositories(db);
  const voice = new FakeVoice();
  const overlay: OverlayMessage[] = [];
  const runner = new BeatRunner({
    bus,
    online,
    store,
    ledger: new SpendLedger(store.costLedger, "replay", 5),
    settings: resolveBeatSettings(),
    sessionId: "replay",
    voice,
    output: new ChatOutput(helix, log),
    model: new StubConsensusModel(),
    moderation: new FakeModerationPort(),
    blocklist: createBlocklist(),
    clients: () => ({ audioConnected: true, audioActive: true, overlayConnected: true }),
    overlay: (message) => overlay.push(message),
    log,
    paidModel: false,
    paidVoice: false,
    simulated: true,
  });
  voice.onReport = (event) => runner.report(event);
  runner.start();
  cleanup.push(async () => {
    await runner.stop();
    online.stop();
    db.close();
  });
  const play = (scenario: Scenario, offset = 0) => {
    for (const line of expandScenario(scenario, { startAt: offset }))
      setTimeout(
        () => {
          if (line.kind === "control") {
            if (line.action === "reconnect") {
              bus.health({ kind: "session", state: "reconnecting" });
              bus.health({ kind: "session", state: "ready" });
            }
          } else {
            const event = mapNotification(line.frame, services.user.id, log);
            if (event) bus.emit(event);
          }
        },
        offset + line.t - Date.now(),
      );
  };
  return { services, bus, runner, store, overlay, voice, play };
}
test("chat replay posts and pins each completed spoken stub once, in that order", async () => {
  const f = await fixture();
  f.play(await load("name-my-cat"));
  await vi.advanceTimersByTimeAsync(34000);
  const writes = f.services.calls.filter(
    (call) =>
      (call.method === "POST" && call.path === "/helix/chat/messages") ||
      (call.method === "PUT" && call.path === "/helix/chat/pins"),
  );
  const rows = f.store.beatLog.recent(100);
  const spoken = rows.filter((row) => row.status === "spoken");
  expect(spoken.length).toBeGreaterThan(0);
  expect(writes.filter((call) => call.path.endsWith("messages"))).toHaveLength(spoken.length);
  expect(writes.map((call) => call.path)).toEqual(
    spoken.flatMap(() => ["/helix/chat/messages", "/helix/chat/pins"]),
  );
  for (let index = 1; index < writes.length; index += 2)
    expect(writes[index]?.at).toBeGreaterThanOrEqual(writes[index - 1]?.at ?? 0);
  expect(rows.every((row) => row.simulated)).toBe(true);
});
test("raid replay waits for the current spoken unit and never writes a second raid notice", async () => {
  const f = await fixture();
  f.play(await load("name-my-cat"));
  f.play(await load("raid-arrival"), 9500);
  await vi.advanceTimersByTimeAsync(9600);
  expect(f.runner.state.step).toBe("speaking");
  expect(f.runner.state.queuedEvent?.notice.kind).toBe("raid");
  await vi.advanceTimersByTimeAsync(8000);
  const event = f.store.beatLog.recent(100).find((row) => row.kind === "event");
  expect(event).toMatchObject({
    status: "spoken",
    line: "Raiders from Friendly Channel just joined the mob, 42 new voices.",
  });
  expect(
    f.services.calls.some(
      (call) => call.path.endsWith("messages") && String(call.body.message).includes("Raiders"),
    ),
  ).toBe(false);
});
test("Hype Train replay speaks each new level at most once and throttles rapid level-ups", async () => {
  const f = await fixture();
  const source = await load("hype-train");
  source.lines = source.lines.filter((line) => line.kind !== "hype" || line.stage !== "end");
  source.lines.push(
    { t: 2500, kind: "hype", stage: "progress", level: 2, total: 1500 },
    { t: 3000, kind: "hype", stage: "progress", level: 3, total: 2000 },
    { t: 22000, kind: "hype", stage: "progress", level: 4, total: 3000, shared: true },
  );
  f.play(source);
  await vi.advanceTimersByTimeAsync(29000);
  const lines = f.store.beatLog.recent(100).map((row) => row.line);
  expect(lines.filter((line) => line?.includes("level 2"))).toHaveLength(1);
  expect(lines.some((line) => line?.includes("level 3"))).toBe(false);
  expect(lines.filter((line) => line?.includes("level 4"))).toHaveLength(1);
  expect(f.runner.view().hype).toEqual({ level: 4, shared: true });
});
test("moderator replay excludes deleted/cleared votes and clears their particles", async () => {
  const f = await fixture();
  f.play(await load("moderator-actions"));
  await vi.advanceTimersByTimeAsync(9000);
  expect(f.runner.state.collection?.voices).toBe(1);
  expect(f.store.beatLog.recent(100)).toEqual([]);
  expect(f.overlay.filter((message) => message.type === "particles_clear")).toHaveLength(3);
});
test("a reconnect handover preserves the collecting window and all its messages", async () => {
  const f = await fixture();
  const id = f.runner.state.collection?.id;
  f.play(await load("reconnect-midstream"));
  await vi.advanceTimersByTimeAsync(2500);
  expect(f.runner.state.collection?.id).toBe(id);
  expect(f.runner.state.collection?.voices).toBe(3);
  expect(f.runner.view().heldBy).toEqual([]);
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.store.beatLog.recent(100).length).toBeGreaterThan(0);
});
test("a short dense crowd keeps every beat accounted for and reports stage distributions", async () => {
  const f = await fixture();
  f.play(generateScenario({ authors: 300, rate: 60, seconds: 20, seed: 42 }));
  await vi.advanceTimersByTimeAsync(22000);
  await f.runner.stop();
  const report = loopReport({
    rows: f.store.beatLog.recent(100),
    calls: f.services.calls,
    runner: f.runner,
    heap: [
      { atMs: 0, bytes: 100 },
      { atMs: 22000, bytes: 100 },
    ],
    elapsedMs: 22000,
    apiFailure: null,
  });
  expect(report.droppedBeats).toBe(0);
  expect(report.pending).toBe(0);
  expect(report.beats).toBeGreaterThan(0);
  expect(report.windowProcessingMs.count).toBeGreaterThan(0);
  expect(report.e2eMs.count).toBeGreaterThan(0);
  expect(report.simulated).toBe(true);
});
