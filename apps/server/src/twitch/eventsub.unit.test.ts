import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { expandScenario, parseScenario } from "../../../../tools/mock-eventsub/src/scenario.js";
import { createMockServer, type MockServer } from "../../../../tools/mock-eventsub/src/server.js";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { acquireInstanceLock, instanceLockFile, serverIsRunning } from "../instance-lock.js";
import { createLogger } from "../log.js";
import { TokenProvider } from "./auth.js";
import { collectEvents, TwitchBus } from "./bus.js";
import { EventSubClient } from "./eventsub.js";
import { HelixClient } from "./helix.js";
import { subscriptionSpecs } from "./subscriptions.js";
import type { StoredToken } from "./token-store.js";

const log = createLogger("silent");
const fixtures: { server: MockServer; client: EventSubClient; auth: TokenProvider }[] = [];
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.client.stop();
    f.auth.stop();
    await f.server.close();
  }
  vi.useRealTimers();
});

export async function flushUntil(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000; i++) {
    if (condition()) return;
    await immediate();
  }
  throw new Error("Mock I/O did not reach the expected state");
}

async function fixture(options: { subscriptions?: boolean } = {}) {
  const server = await createMockServer({ clock: systemClock, autoPlay: false });
  const config = loadConfig({
    TWITCH_CLIENT_ID: "mock-client",
    TWITCH_CLIENT_SECRET: "mock-secret",
    TWITCH_CHANNEL: "spokesmob_demo",
    EVENTSUB_URL: `${server.wsUrl}?keepalive_timeout_seconds=10`,
    HELIX_URL: server.helixUrl,
    TWITCH_AUTH_URL: server.authUrl,
  });
  const token: StoredToken = {
    accessToken: server.services.auth.accessToken,
    refreshToken: server.services.auth.refreshToken,
    scopes: server.services.auth.scopes,
    userId: server.services.auth.userId,
    login: server.services.auth.login,
    clientId: server.services.clientId,
    expiresAt: Date.now() + 3_600_000,
    obtainedAt: Date.now(),
  };
  const auth = new TokenProvider({
    config,
    log,
    clock: systemClock,
    fetch: server.services.fetch,
    store: { load: async () => token, save: async () => undefined },
  });
  await auth.start();
  const helix = new HelixClient({
    config,
    auth,
    log,
    clock: systemClock,
    fetch: server.services.fetch,
    channelId: token.userId,
  });
  const bus = new TwitchBus();
  const collected = collectEvents(bus);
  const client = new EventSubClient({
    config,
    auth,
    helix,
    log,
    bus,
    channelId: token.userId,
    clock: systemClock,
    random: () => 0,
    ...(options.subscriptions === false ? { specs: [] } : {}),
  });
  fixtures.push({ server, client, auth });
  return { server, client, auth, helix, collected };
}
function chatFrame(messageId = "one") {
  const scenario = parseScenario(
    '{"scenario":"one","channel":{"id":"100000001","login":"spokesmob_demo"}}\n{"t":0,"kind":"chat","user":"viewer01","name":"Viewer 01","text":"Hello room"}',
  );
  const line = expandScenario(scenario, { startAt: Date.now() })[0];
  if (line?.kind !== "notification") throw new Error("Expected notification");
  line.frame.metadata.message_id = messageId;
  return line.frame;
}

test("welcome creates every subscription immediately and typed notifications deduplicate", async () => {
  const f = await fixture();
  f.client.start();
  await flushUntil(() => f.client.state === "ready");
  expect(f.client.subscriptions.size).toBe(subscriptionSpecs("1", "1").length);
  expect(
    f.collected.health
      .filter((event) => event.kind === "subscription")
      .every((event) => event.kind === "subscription" && (event.elapsedMs ?? 2000) < 2000),
  ).toBe(true);
  const frame = chatFrame();
  f.server.inject(frame);
  f.server.inject(frame);
  await flushUntil(() => f.collected.events.length > 0);
  for (let i = 0; i < 10; i++) await immediate();
  expect(f.collected.events).toHaveLength(1);
  expect(f.collected.events[0]).toMatchObject({ kind: "chat", text: "Hello room" });
  const stale = chatFrame("stale");
  stale.metadata.message_timestamp = new Date(Date.now() - 600_001).toISOString();
  f.server.inject(stale);
  for (let i = 0; i < 20; i++) await immediate();
  expect(f.collected.events).toHaveLength(1);
});

test("server reconnect uses its URL exactly, retains subscriptions and shares dedupe", async () => {
  const f = await fixture();
  f.client.start();
  await flushUntil(() => f.client.state === "ready");
  const ids = [...f.client.subscriptions.keys()];
  const before = f.client.sessionId;
  const frame = chatFrame("overlap");
  f.server.inject(frame);
  await flushUntil(() => f.collected.events.length === 1);
  f.server.reconnect();
  await flushUntil(() => f.client.state === "ready" && f.client.sessionId !== before);
  f.server.inject(frame);
  for (let i = 0; i < 20; i++) await immediate();
  expect(f.collected.events).toHaveLength(1);
  expect([...f.client.subscriptions.keys()]).toEqual(ids);
  expect(
    f.server.services.calls.filter(
      (call) => call.path.endsWith("/subscriptions") && call.method === "POST",
    ),
  ).toHaveLength(ids.length);
  expect(f.collected.health).toContainEqual({
    kind: "reconnect",
    count: 1,
    reason: "server_reconnect",
    resubscribed: false,
  });
  await flushUntil(() => f.server.sessions.size === 1);
});

test("silence expires the watchdog and recreates subscriptions on a fresh session", async () => {
  const f = await fixture();
  f.client.start();
  await flushUntil(() => f.client.state === "ready");
  const before = f.client.sessionId;
  f.server.silence(30_000);
  await vi.advanceTimersByTimeAsync(12_000);
  await flushUntil(() => f.client.state === "backoff");
  await flushUntil(() => f.server.sessions.size === 0);
  await vi.advanceTimersByTimeAsync(1000);
  await flushUntil(() => f.client.state === "ready");
  expect(f.client.sessionId).not.toBe(before);
  expect(f.client.subscriptions.size).toBe(subscriptionSpecs("1", "1").length);
  expect(
    f.collected.health.some(
      (event) => event.kind === "reconnect" && event.reason === "watchdog" && event.resubscribed,
    ),
  ).toBe(true);
});

test.each([4000, 4001, 4002, 4003, 4004, 4005, 4006, 4007])(
  "close %i reconnects to a fresh session",
  async (code) => {
    const f = await fixture();
    f.client.start();
    await flushUntil(() => f.client.state === "ready");
    const previous = f.client.sessionId;
    f.server.closeSockets(code);
    await flushUntil(() => f.client.state === "backoff" && f.server.sessions.size === 0);
    await vi.advanceTimersByTimeAsync(1000);
    await flushUntil(() => f.client.state === "ready");
    expect(f.client.sessionId).not.toBe(previous);
    expect(
      f.collected.health.some(
        (event) => event.kind === "reconnect" && event.reason === `close_${code}`,
      ),
    ).toBe(true);
  },
);

test("revocations surface health and revoked authorization stops the session", async () => {
  const f = await fixture();
  f.client.start();
  await flushUntil(() => f.client.state === "ready");
  f.server.revoke("channel.raid", "version_removed");
  await flushUntil(() =>
    f.collected.health.some(
      (event) => event.kind === "subscription" && event.status === "version_removed",
    ),
  );
  expect(f.client.subscriptions.size).toBe(subscriptionSpecs("1", "1").length - 1);
  f.server.revoke("channel.chat.message", "authorization_revoked");
  await flushUntil(() => f.client.state === "idle");
  expect(f.collected.health).toContainEqual({ kind: "auth", state: "auth_required" });
  await expect(f.auth.getAccessToken()).rejects.toThrow("sign-in required");
});

test("subscription conflicts are tolerated and stale transport cleanup stays scoped to WebSockets", async () => {
  const f = await fixture();
  f.client.start();
  await flushUntil(() => f.client.state === "ready");
  const spec = subscriptionSpecs(f.auth.identity.userId, f.auth.identity.userId)[0];
  if (!spec || !f.client.sessionId) throw new Error("Expected active subscription");
  const existing = await f.helix.createSubscription(spec, f.client.sessionId);
  expect(f.client.subscriptions.has(existing.id)).toBe(true);
  f.server.services.subscriptions.set("stale", {
    ...f.server.services.subscriptions.values().next().value,
    id: "stale",
    type: "stream.online",
    version: "1",
    status: "enabled",
    condition: {},
    transport: { method: "websocket", session_id: "old-session" },
    created_at: new Date().toISOString(),
    cost: 0,
  });
  await f.client.cleanupStaleSubscriptions();
  expect(f.server.services.subscriptions.has("stale")).toBe(false);
  expect(f.client.subscriptions.has(existing.id)).toBe(true);
});

test("missing subscription permissions require authorization without reconnecting", async () => {
  const f = await fixture();
  f.server.services.failNext({
    path: "/helix/eventsub/subscriptions",
    method: "POST",
    status: 403,
  });
  f.client.start();
  await flushUntil(() => f.client.state === "idle");
  expect(f.collected.health).toContainEqual({ kind: "auth", state: "auth_required" });
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.client.state).toBe("idle");
  expect(f.client.subscriptions.size).toBe(0);
});

test("transport-limit errors clean stale subscriptions before creating a fresh session", async () => {
  const f = await fixture();
  f.server.services.subscriptions.set("stale", {
    id: "stale",
    type: "stream.online",
    version: "1",
    status: "enabled",
    condition: {},
    transport: { method: "websocket", session_id: "old-session" },
    created_at: new Date().toISOString(),
    cost: 0,
  });
  f.server.services.failNext({
    path: "/helix/eventsub/subscriptions",
    method: "POST",
    status: 429,
    headers: { "Ratelimit-Remaining": "10" },
    body: { message: "maximum websocket transports limit" },
  });
  f.client.start();
  await flushUntil(() => f.client.state === "backoff" && f.server.sessions.size === 0);
  expect(f.server.services.subscriptions.has("stale")).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  await flushUntil(() => f.client.state === "ready");
});

test("dedupe entries expire after ten minutes and stop removes owned subscriptions", async () => {
  const f = await fixture();
  f.client.start();
  await flushUntil(() => f.client.state === "ready");
  f.server.inject(chatFrame("expiring"));
  await flushUntil(() => f.collected.events.length === 1);
  vi.setSystemTime(Date.now() + 600_001);
  f.server.inject(chatFrame("expiring"));
  await flushUntil(() => f.collected.events.length === 2);
  const count = f.client.subscriptions.size;
  await f.client.stop();
  expect(
    f.server.services.calls.filter(
      (call) => call.path.endsWith("/subscriptions") && call.method === "DELETE",
    ),
  ).toHaveLength(count);
  expect(f.server.services.subscriptions.size).toBe(0);
});

test("instance lock prevents a second owner and replaces only a dead owner", async () => {
  const directory = await mkdtemp(join(process.cwd(), "lock-test-"));
  const tokenFile = join(directory, "tokens.json");
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireInstanceLock(tokenFile);
    expect(await serverIsRunning(tokenFile)).toBe(true);
    await expect(acquireInstanceLock(tokenFile)).rejects.toThrow("already running");
    await release();
    release = undefined;
    await writeFile(
      instanceLockFile(tokenFile),
      JSON.stringify({ pid: 2_147_483_647, owner: "dead-owner", startTime: "2000-01-01" }),
    );
    release = await acquireInstanceLock(tokenFile);
    expect(await serverIsRunning(tokenFile)).toBe(true);
  } finally {
    await release?.();
    await unlink(instanceLockFile(tokenFile)).catch(() => undefined);
    await rmdir(directory);
  }
});
