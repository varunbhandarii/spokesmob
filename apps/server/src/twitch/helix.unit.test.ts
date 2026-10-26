import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockServices } from "../../../../tools/mock-eventsub/src/services.js";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { TokenProvider } from "./auth.js";
import { HelixClient } from "./helix.js";
import { RateLimiter } from "./rate-limit.js";
import type { StoredToken } from "./token-store.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});
const config = loadConfig({
  TWITCH_CLIENT_ID: "mock-client",
  TWITCH_CLIENT_SECRET: "mock-secret",
  TWITCH_CHANNEL: "spokesmob_demo",
  HELIX_URL: "http://mock/helix",
  TWITCH_AUTH_URL: "http://mock/oauth2",
});
const log = createLogger("silent");
async function fixture() {
  const mock = createMockServices({ clock: systemClock });
  const token: StoredToken = {
    accessToken: mock.auth.accessToken,
    refreshToken: mock.auth.refreshToken,
    clientId: mock.clientId,
    userId: mock.auth.userId,
    login: mock.auth.login,
    scopes: mock.auth.scopes,
    obtainedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  };
  const auth = new TokenProvider({
    config,
    log,
    clock: systemClock,
    fetch: mock.fetch,
    store: { load: async () => token, save: async () => undefined },
  });
  await auth.start();
  auth.stop();
  const client = new HelixClient({
    config,
    auth,
    log,
    channelId: mock.auth.userId,
    fetch: mock.fetch,
    clock: systemClock,
  });
  return { mock, client, auth };
}

test("an idempotent request refreshes on unauthorized once and retries once", async () => {
  const f = await fixture();
  f.mock.failNext({ path: "/helix/users", status: 401 });
  expect(await f.client.getUsers()).toHaveLength(1);
  expect(f.mock.calls.filter((call) => call.path === "/helix/users")).toHaveLength(2);
  expect(f.mock.calls.filter((call) => call.body.grant_type === "refresh_token")).toHaveLength(1);
  f.mock.failNext({ path: "/helix/users", status: 401 });
  f.mock.failNext({ path: "/helix/users", status: 401 });
  await expect(f.client.getUsers()).rejects.toMatchObject({ status: 401 });
});

test("rate exhaustion waits for reset once and remaining capacity surfaces an error", async () => {
  const f = await fixture();
  f.mock.failNext({
    path: "/helix/users",
    status: 429,
    headers: { "Ratelimit-Remaining": "0", "Ratelimit-Reset": String((Date.now() + 2000) / 1000) },
  });
  const request = f.client.getUsers();
  await vi.advanceTimersByTimeAsync(1999);
  expect(f.mock.calls.filter((call) => call.path === "/helix/users")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  await request;
  expect(f.mock.calls.filter((call) => call.path === "/helix/users")).toHaveLength(2);
  f.mock.failNext({ path: "/helix/users", status: 429, headers: { "Ratelimit-Remaining": "5" } });
  await expect(f.client.getUsers()).rejects.toMatchObject({ status: 429 });
  expect(f.mock.calls.filter((call) => call.path === "/helix/users")).toHaveLength(3);
});

test("server errors retry idempotent reads three times with bounded backoff", async () => {
  const f = await fixture();
  for (let i = 0; i < 4; i++) f.mock.failNext({ path: "/helix/users", status: 503 });
  const request = expect(f.client.getUsers()).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(3500);
  await request;
  const calls = f.mock.calls.filter((call) => call.path === "/helix/users");
  expect(calls.map((call) => call.at - (calls[0]?.at ?? 0))).toEqual([0, 500, 1500, 3500]);
});

test("chat and announcements never retry unauthorized, rate or server failures", async () => {
  for (const status of [401, 429, 503]) {
    const f = await fixture();
    f.mock.failNext({ path: "/helix/chat/messages", status });
    await expect(f.client.sendChatMessage({ text: `message ${status}` })).rejects.toMatchObject({
      status,
    });
    f.mock.failNext({ path: "/helix/chat/announcements", status });
    // An exhausted platform bucket pauses later calls, without repeating the failed send.
    const announcement = expect(
      f.client.sendAnnouncement(`announcement ${status}`),
    ).rejects.toMatchObject({ status });
    await vi.advanceTimersByTimeAsync(1000);
    await announcement;
    expect(f.mock.calls.filter((call) => call.path.startsWith("/helix/chat/"))).toHaveLength(2);
    expect(f.mock.calls.filter((call) => call.body.grant_type === "refresh_token")).toHaveLength(0);
  }
});

test("length validation and concurrent normalized duplicates make no extra requests", async () => {
  const f = await fixture();
  await expect(f.client.sendChatMessage({ text: "x".repeat(501) })).rejects.toThrow("500");
  const results = await Promise.all([
    f.client.sendChatMessage({ text: "Hello Chat" }),
    f.client.sendChatMessage({ text: "  hello   chat " }),
  ]);
  expect(results.filter((item) => item.suppressed)).toHaveLength(1);
  expect(f.mock.calls.filter((call) => call.path === "/helix/chat/messages")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await f.client.sendChatMessage({ text: "Hello Chat" })).sent).toBe(true);
});

test("a missing chat result is logged as not sent without a retry or pin", async () => {
  const f = await fixture();
  const lines: string[] = [];
  const logger = createLogger("info", {
    write: (line: string) => {
      lines.push(line);
    },
  });
  const client = new HelixClient({
    config,
    auth: f.auth,
    log: logger,
    channelId: f.mock.auth.userId,
    fetch: f.mock.fetch,
    clock: systemClock,
  });
  f.mock.failNext({ path: "/helix/chat/messages", status: 200, body: { data: [] } });
  expect(await client.sendChatMessage({ text: "uncertain delivery" })).toEqual({
    messageId: null,
    sent: false,
    dropReason: "missing_response_entry",
    suppressed: false,
  });
  expect(f.mock.calls.filter((call) => call.path === "/helix/chat/messages")).toHaveLength(1);
  expect(f.mock.calls.filter((call) => call.path === "/helix/chat/pins")).toHaveLength(0);
  expect(lines.some((line) => line.includes("missing_response_entry"))).toBe(true);
  expect((await client.sendChatMessage({ text: "uncertain delivery" })).suppressed).toBe(true);
  expect(f.mock.calls.filter((call) => call.path === "/helix/chat/messages")).toHaveLength(1);
});

test("duplicate reservations remain active while a send waits for capacity", async () => {
  const f = await fixture();
  const limiter = new RateLimiter(systemClock);
  limiter.pauseUntil(Date.now() + 60_000);
  const client = new HelixClient({
    config,
    auth: f.auth,
    log,
    channelId: f.mock.auth.userId,
    fetch: f.mock.fetch,
    clock: systemClock,
    limiter,
  });
  const pending = client.sendChatMessage({ text: "a queued message" });
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await client.sendChatMessage({ text: "a queued message" })).suppressed).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await pending).sent).toBe(true);
  expect((await client.sendChatMessage({ text: "a queued message" })).suppressed).toBe(true);
  expect(f.mock.calls.filter((call) => call.path === "/helix/chat/messages")).toHaveLength(1);
});

test("drop reasons stay opaque and pins are separate query-based calls", async () => {
  const f = await fixture();
  f.mock.dropNextChat("future_drop_code");
  expect(await f.client.sendChatMessage({ text: "a held line" })).toMatchObject({
    sent: false,
    dropReason: "future_drop_code",
  });
  const sent = await f.client.sendChatMessage({
    text: "a permitted line",
    replyTo: "parent-message",
  });
  expect(sent.sent).toBe(true);
  await f.client.pinMessage(sent.messageId ?? "", 60);
  await f.client.updatePin(sent.messageId ?? "", 120);
  expect((await f.client.getPin())?.message_id).toBe(sent.messageId);
  await f.client.unpinMessage(sent.messageId ?? "");
  expect(await f.client.getPin()).toBeNull();
  const sends = f.mock.calls.filter((call) => call.path === "/helix/chat/messages");
  expect(sends[1]?.body).toMatchObject({
    sender_id: f.mock.auth.userId,
    reply_parent_message_id: "parent-message",
  });
  expect(sends[1]?.body).not.toHaveProperty("pin");
  expect(sends[1]?.body).not.toHaveProperty("for_source_only");
  expect(
    f.mock.calls.find((call) => call.path === "/helix/chat/pins" && call.method === "PUT")?.query
      .duration_seconds,
  ).toBe("60");
});

test("a duplicate subscription resolves the existing ID and list reads paginate", async () => {
  const f = await fixture();
  f.mock.registerSession("session");
  const spec = {
    type: "channel.chat.message",
    version: "1",
    condition: { broadcaster_user_id: f.mock.auth.userId, user_id: f.mock.auth.userId },
  };
  const first = await f.client.createSubscription(spec, "session");
  expect((await f.client.createSubscription(spec, "session")).id).toBe(first.id);
  await f.client.deleteSubscription(first.id);
  expect(await f.client.listSubscriptions()).toEqual([]);
  f.mock.failNext({
    path: "/helix/moderation/blocked_terms",
    status: 200,
    body: { data: [{ id: "term-a", text: "synthetic-term" }], pagination: { cursor: "next" } },
  });
  expect(await f.client.getBlockedTerms()).toEqual([{ id: "term-a", text: "synthetic-term" }]);
  expect(f.mock.calls.at(-1)?.query).toMatchObject({ first: "100", after: "next" });
  expect(
    await f.client.updateChatSettings({ slow_mode: true, slow_mode_wait_time: 5 }),
  ).toMatchObject({ slow_mode: true });
});

test("rolling rate limits constrain bursts and respect platform exhaustion", async () => {
  const limiter = new RateLimiter(systemClock);
  for (let i = 0; i < 60; i++) await limiter.acquire("chat");
  let complete = false;
  const next = limiter.acquire("chat").then(() => {
    complete = true;
  });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await next;
  await limiter.acquire("announce");
  const second = limiter.acquire("announce");
  await vi.advanceTimersByTimeAsync(2500);
  await second;
  limiter.observe(
    new Headers({
      "Ratelimit-Remaining": "0",
      "Ratelimit-Reset": String((Date.now() + 4000) / 1000),
    }),
  );
  complete = false;
  const paused = limiter.acquire().then(() => {
    complete = true;
  });
  await vi.advanceTimersByTimeAsync(3999);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await paused;
});
