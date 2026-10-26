import { readFileSync } from "node:fs";
import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { generateScenario } from "../../../../tools/crowd-sim/src/generate.js";
import {
  expandScenario,
  parseScenario,
  type Scenario,
} from "../../../../tools/mock-eventsub/src/scenario.js";
import { createMockServer, type MockServer } from "../../../../tools/mock-eventsub/src/server.js";
import { anonymizeRecording } from "../../../../tools/recorder/src/anonymize.js";
import { setup } from "../cli/setup.js";
import { twitchCheck, writeCheck } from "../cli/twitch-check.js";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { collectEvents } from "./bus.js";
import { createTwitchRuntime, type TwitchRuntime } from "./runtime.js";
import type { StoredToken, TokenStore } from "./token-store.js";

const resources: { server: MockServer; runtime: TwitchRuntime }[] = [];
const log = createLogger("silent");
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("External fetch is forbidden in offline tests"),
  );
});
afterEach(async () => {
  for (const f of resources.splice(0)) {
    await f.runtime.stop();
    await f.server.close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function flushUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    if (condition()) return;
    await immediate();
  }
  throw new Error("Mock playback did not reach its expected state");
}
async function advance(milliseconds: number, step = 25): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, milliseconds - elapsed));
    for (let turn = 0; turn < 10; turn++) await immediate();
  }
}
function scenario(name: string): Scenario {
  return parseScenario(
    readFileSync(
      new URL(`../../../../tools/mock-eventsub/scenarios/${name}.jsonl`, import.meta.url),
      "utf8",
    ),
  );
}
async function fixture(
  input?: Scenario,
  options: { literalTimestamps?: boolean; loop?: boolean; freshSetup?: boolean } = {},
) {
  const server = await createMockServer({
    clock: systemClock,
    autoPlay: false,
    speed: 20,
    ...(input ? { scenario: input } : {}),
    ...(options.literalTimestamps === undefined
      ? {}
      : { literalTimestamps: options.literalTimestamps }),
    ...(options.loop === undefined ? {} : { loop: options.loop }),
  });
  const config = loadConfig({
    TWITCH_CLIENT_ID: server.services.clientId,
    TWITCH_CLIENT_SECRET: "mock-secret",
    TWITCH_CHANNEL: server.services.user.login,
    HELIX_URL: server.helixUrl,
    TWITCH_AUTH_URL: server.authUrl,
    EVENTSUB_URL: server.wsUrl,
    LOG_LEVEL: "silent",
  });
  let saved: StoredToken | null = options.freshSetup
    ? null
    : {
        accessToken: server.services.auth.accessToken,
        refreshToken: server.services.auth.refreshToken,
        userId: server.services.auth.userId,
        login: server.services.auth.login,
        scopes: server.services.auth.scopes,
        clientId: server.services.clientId,
        obtainedAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      };
  const store: TokenStore = {
    load: async () => saved,
    save: async (token) => {
      saved = token;
    },
  };
  const lines: string[] = [];
  let activations = 0;
  if (options.freshSetup) {
    const signIn = setup({
      config,
      store,
      clock: systemClock,
      fetch: server.services.fetch,
      output: (line) => lines.push(line),
      activation: () => {
        activations++;
      },
    });
    await advance(5000, 1000);
    await signIn;
    await setup({
      config,
      store,
      clock: systemClock,
      fetch: server.services.fetch,
      output: (line) => lines.push(line),
      activation: () => {
        activations++;
      },
    });
  }
  const runtime = await createTwitchRuntime({
    config,
    store,
    clock: systemClock,
    fetch: server.services.fetch,
    log,
  });
  resources.push({ server, runtime });
  const collected = collectEvents(runtime.bus);
  return { server, runtime, config, collected, lines, activations, saved: () => saved };
}

test.each(["name-my-cat", "hype-train", "raid-arrival"])(
  "%s replays ordered typed events at twenty times speed",
  async (name) => {
    const input = scenario(name);
    const f = await fixture(input);
    f.runtime.client.start();
    await flushUntil(() => f.runtime.client.state === "ready");
    f.server.play();
    const duration = Math.max(...input.lines.map((line) => line.t)) / 20 + 25;
    await advance(duration);
    await flushUntil(
      () =>
        f.collected.events.length === input.lines.filter((line) => line.kind !== "control").length,
    );
    expect(f.collected.events).toMatchSnapshot();
  },
);

test("offline sign-in reuses authorization, receives chat and performs the guarded write check", async () => {
  const f = await fixture(scenario("raid-arrival"), { freshSetup: true });
  expect(f.activations).toBe(1);
  expect(f.saved()?.scopes).toHaveLength(14);
  expect(f.lines[0]).toContain("14 scopes");
  expect(f.lines[1]).toBe(`Signed in as ${f.server.services.user.login}`);
  f.runtime.client.start();
  await flushUntil(() => f.runtime.client.state === "ready");
  f.server.play();
  await advance(1000);
  await flushUntil(() => f.collected.events.some((event) => event.kind === "chat"));
  const write = writeCheck(f.runtime.helix, (line) => f.lines.push(line), systemClock);
  await advance(58_000, 500);
  expect(await write).toBe(true);
  const calls = f.server.services.calls;
  expect(
    calls.filter((call) => call.body.grant_type === "urn:ietf:params:oauth:grant-type:device_code"),
  ).toHaveLength(1);
  expect(calls.filter((call) => call.path === "/helix/chat/messages")).toHaveLength(1);
  expect(calls.some((call) => call.path === "/helix/chat/pins" && call.method === "PUT")).toBe(
    true,
  );
  expect(calls.some((call) => call.path === "/helix/chat/pins" && call.method === "DELETE")).toBe(
    true,
  );
  expect(f.lines).toContain("Identical second send suppressed locally.");
  expect(JSON.stringify(calls)).not.toContain(f.server.services.auth.accessToken);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("completed polls subscribe once and deliver vote totals alongside reward events", async () => {
  const f = await fixture(scenario("poll-and-redemption"));
  f.runtime.client.start();
  await flushUntil(() => f.runtime.client.state === "ready");

  const requests = f.server.services.calls.filter(
    (call) =>
      call.method === "POST" &&
      call.path === "/helix/eventsub/subscriptions" &&
      call.body.type === "channel.poll.end",
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.body).toMatchObject({
    type: "channel.poll.end",
    version: "1",
    condition: { broadcaster_user_id: f.runtime.channel.id },
    transport: { method: "websocket", session_id: f.runtime.client.sessionId },
  });

  f.server.play();
  await advance(50);
  await flushUntil(() => f.collected.events.length === 2);
  expect(f.collected.events.map((event) => event.kind)).toEqual(["pollEnd", "redemption"]);
  expect(f.collected.events[0]).toMatchObject({
    kind: "pollEnd",
    title: "Name the cat",
    status: "completed",
    choices: [
      { id: "choice-gary", title: "Gary", votes: 24 },
      { id: "choice-pickles", title: "Pickles", votes: 16 },
    ],
  });
  expect(f.collected.events).toMatchSnapshot();
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("generated crowd conversations replay through the WebSocket client", async () => {
  const input = generateScenario({ authors: 12, rate: 6, seconds: 2, seed: 3 });
  const f = await fixture(input);
  f.runtime.client.start();
  await flushUntil(() => f.runtime.client.state === "ready");
  f.server.play();
  await advance(150);
  await flushUntil(() => f.collected.events.length === 12);
  expect(f.collected.events.every((event) => event.kind === "chat")).toBe(true);
});

function archivedScenario(): Scenario {
  const first = expandScenario(scenario("name-my-cat"), { startAt: Date.UTC(2000, 0, 1) })[0];
  if (first?.kind !== "notification") throw new Error("Expected chat frame");
  const source = JSON.stringify({ t: 0, frame: first.frame });
  return parseScenario(anonymizeRecording(source, { replaceText: true }));
}
test("anonymized archived notifications replay after adaptation and remain stale in literal mode", async () => {
  for (const literalTimestamps of [false, true]) {
    const f = await fixture(archivedScenario(), { literalTimestamps });
    f.runtime.client.start();
    await flushUntil(() => f.runtime.client.state === "ready");
    f.server.play();
    await advance(100);
    if (!literalTimestamps) await flushUntil(() => f.collected.events.length === 1);
    expect(f.collected.events).toHaveLength(literalTimestamps ? 0 : 1);
    if (!literalTimestamps)
      expect(f.collected.events[0]).toMatchObject({
        kind: "chat",
        author: { login: expect.stringMatching(/^viewer\d+$/) },
        text: "Synthetic chat",
      });
  }
});

test("loop playback remains visible to the client's dedupe guard", async () => {
  const f = await fixture(archivedScenario(), { loop: true });
  f.runtime.client.start();
  await flushUntil(() => f.runtime.client.state === "ready");
  f.server.play();
  await advance(10, 1);
  await flushUntil(() => f.collected.events.length >= 2);
  expect(f.collected.events.length).toBeGreaterThanOrEqual(2);
});

test("reconnect scenario keeps event counts and creates no replacement subscriptions", async () => {
  const input = scenario("reconnect-midstream");
  const f = await fixture(input);
  f.runtime.client.start();
  await flushUntil(() => f.runtime.client.state === "ready");
  const count = f.runtime.client.subscriptions.size;
  f.server.play();
  await advance(Math.max(...input.lines.map((line) => line.t)) / 20 + 100);
  await flushUntil(
    () => f.collected.events.length === input.lines.filter((line) => line.kind === "chat").length,
  );
  expect(
    f.server.services.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/subscriptions"),
    ),
  ).toHaveLength(count);
  expect(
    f.collected.health.some((event) => event.kind === "reconnect" && !event.resubscribed),
  ).toBe(true);
});

test("check status and listen commands work against only the project mock", async () => {
  const f = await fixture(scenario("name-my-cat"));
  const lines: string[] = [];
  const capture = twitchCheck({
    config: f.config,
    runtime: f.runtime,
    args: ["--status", "--listen", "2"],
    output: (line) => lines.push(line),
    clock: systemClock,
  });
  await flushUntil(() => f.runtime.client.state === "ready");
  f.server.play();
  await advance(2100);
  await capture;
  expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
    login: f.server.services.user.login,
    channelId: f.server.services.user.id,
  });
  expect(lines).toContain("Capture active; send your chat samples now.");
  expect(lines.some((line) => line.includes('"fragments"'))).toBe(true);
  expect(lines.join("\n")).not.toContain(f.server.services.auth.accessToken);
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
