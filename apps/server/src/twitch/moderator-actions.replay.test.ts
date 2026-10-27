import { readFileSync } from "node:fs";
import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expandScenario, parseScenario } from "../../../../tools/mock-eventsub/src/scenario.js";
import { createMockServer, type MockServer } from "../../../../tools/mock-eventsub/src/server.js";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { collectEvents } from "./bus.js";
import { createTwitchRuntime, type TwitchRuntime } from "./runtime.js";
import type { StoredToken } from "./token-store.js";

let server: MockServer | undefined;
let runtime: TwitchRuntime | undefined;
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External requests are forbidden"));
});
afterEach(async () => {
  await runtime?.stop();
  await server?.close();
  runtime = undefined;
  server = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function flushUntil(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 10_000; turn++) {
    if (condition()) return;
    await immediate();
  }
  throw new Error("Moderator action replay did not reach the expected state");
}

test("moderator actions replay through the shared socket with target IDs and duplicate protection", async () => {
  const scenario = parseScenario(
    readFileSync(
      new URL("../../../../tools/mock-eventsub/scenarios/moderator-actions.jsonl", import.meta.url),
      "utf8",
    ),
  );
  server = await createMockServer({ clock: systemClock, autoPlay: false, speed: 20, scenario });
  const mock = server;
  const config = loadConfig({
    TWITCH_CLIENT_ID: mock.services.clientId,
    TWITCH_CLIENT_SECRET: "mock-secret",
    TWITCH_CHANNEL: mock.services.user.login,
    HELIX_URL: mock.helixUrl,
    TWITCH_AUTH_URL: mock.authUrl,
    EVENTSUB_URL: mock.wsUrl,
    LOG_LEVEL: "silent",
  });
  const saved: StoredToken = {
    accessToken: mock.services.auth.accessToken,
    refreshToken: mock.services.auth.refreshToken,
    userId: mock.services.auth.userId,
    login: mock.services.auth.login,
    scopes: mock.services.auth.scopes,
    clientId: mock.services.clientId,
    obtainedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  };
  runtime = await createTwitchRuntime({
    config,
    clock: systemClock,
    fetch: mock.services.fetch,
    store: { load: async () => saved, save: async () => undefined },
    log: createLogger("silent"),
  });
  const active = runtime;
  const collected = collectEvents(active.bus);
  active.client.start();
  await flushUntil(() => active.client.state === "ready");
  const playbackAt = Date.now();
  mock.play();
  for (let step = 0; step < 9; step++) {
    await vi.advanceTimersByTimeAsync(5);
    for (let turn = 0; turn < 10; turn++) await immediate();
  }
  await flushUntil(() => collected.events.length === 8);
  expect(collected.events.map((event) => event.kind)).toEqual([
    "chat",
    "chat",
    "chatDelete",
    "chat",
    "chatClearUser",
    "chat",
    "chatClear",
    "chat",
  ]);
  const first = collected.events[0];
  const second = collected.events[1];
  if (first?.kind !== "chat" || second?.kind !== "chat") throw new Error("Expected chat");
  expect(collected.events[2]).toEqual({
    kind: "chatDelete",
    channelId: first.channelId,
    messageId: first.id,
    userId: first.author.id,
    at: new Date(playbackAt + 10).toISOString(),
  });
  expect(collected.events[4]).toEqual({
    kind: "chatClearUser",
    channelId: second.channelId,
    userId: second.author.id,
    at: new Date(playbackAt + 20).toISOString(),
  });
  expect(collected.events[6]).toEqual({
    kind: "chatClear",
    channelId: first.channelId,
    at: new Date(playbackAt + 30).toISOString(),
  });
  for (const index of [2, 4, 6]) {
    const line = expandScenario(scenario, { startAt: playbackAt })[index];
    if (line?.kind !== "notification") throw new Error("Expected moderator action");
    mock.inject(line.frame);
    const stale = structuredClone(line.frame);
    stale.metadata.message_id += ":stale";
    stale.metadata.message_timestamp = new Date(Date.now() - 600_001).toISOString();
    mock.inject(stale);
  }
  for (let turn = 0; turn < 20; turn++) await immediate();
  expect(collected.events).toHaveLength(8);
  expect(mock.services.subscriptions.size).toBe(13);
  expect(active.client.subscriptions.size).toBe(13);
});
