import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockServices } from "../../../../tools/mock-eventsub/src/services.js";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { HelixClient } from "../twitch/helix.js";
import { compactEvent, parseCheckArguments, writeCheck } from "./twitch-check.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});
function fixture() {
  const mock = createMockServices({ clock: systemClock });
  const config = loadConfig({
    TWITCH_CLIENT_ID: mock.clientId,
    TWITCH_CLIENT_SECRET: "mock-secret",
    TWITCH_CHANNEL: mock.user.login,
    HELIX_URL: "http://mock/helix",
  });
  const auth = {
    identity: {
      userId: mock.auth.userId,
      login: mock.auth.login,
      scopes: mock.auth.scopes,
      expiresAt: Date.now() + 3_600_000,
    },
    getAccessToken: async () => mock.auth.accessToken,
    onUnauthorized: async () => mock.auth.accessToken,
  };
  const client = new HelixClient({
    config,
    auth,
    channelId: mock.user.id,
    clock: systemClock,
    fetch: mock.fetch,
    log: createLogger("silent"),
  });
  return { mock, client };
}

test("check arguments default to status and reject invalid listen durations", () => {
  expect(parseCheckArguments([])).toEqual({ status: true, write: false });
  expect(parseCheckArguments(["--listen", "120", "--write"])).toEqual({
    status: false,
    write: true,
    listen: 120,
  });
  expect(() => parseCheckArguments(["--listen", "0"])).toThrow("positive");
  expect(() => parseCheckArguments(["--unknown"])).toThrow("Use");
});

test("write verification suppresses immediately, holds the pin, then unpins and announces", async () => {
  const f = fixture();
  const lines: string[] = [];
  const result = writeCheck(f.client, (line) => lines.push(line), systemClock);
  await vi.advanceTimersByTimeAsync(57_999);
  expect(f.mock.calls.map((call) => call.method)).toEqual(["POST", "PUT", "GET"]);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(true);
  expect(f.mock.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
    "POST /helix/chat/messages",
    "PUT /helix/chat/pins",
    "GET /helix/chat/pins",
    "DELETE /helix/chat/pins",
    "POST /helix/chat/announcements",
  ]);
  expect(f.mock.calls[1]?.query.duration_seconds).toBe("60");
  expect(f.mock.calls.at(-1)?.body.color).toBe("purple");
  expect(lines).toContain("Identical second send suppressed locally.");
});

test("missing, held and inconsistent send results never pin or retry", async () => {
  for (const data of [
    [],
    [{ message_id: "held", is_sent: false, drop_reason: { code: "automod_held" } }],
    [{ message_id: "uncertain", is_sent: true, drop_reason: { code: "future_reason" } }],
  ]) {
    const f = fixture();
    f.mock.failNext({ path: "/helix/chat/messages", status: 200, body: { data } });
    expect(await writeCheck(f.client, () => undefined, systemClock)).toBe(false);
    expect(f.mock.calls).toHaveLength(1);
    expect(f.mock.calls[0]?.path).toBe("/helix/chat/messages");
  }
});

test("compact chat output includes reply and self markers without raw provider data", () => {
  expect(
    compactEvent({
      kind: "chat",
      id: "message",
      at: "now",
      channelId: "channel",
      self: true,
      author: {
        id: "user",
        login: "viewer01",
        name: "Viewer 01",
        color: null,
        broadcaster: true,
        moderator: false,
        vip: false,
        subscriber: false,
      },
      text: "Hello room",
      fragments: [{ type: "text", text: "Hello room" }],
      messageType: "text",
      replyToId: "parent",
    }),
  ).toEqual({
    kind: "chat",
    author: "Viewer 01",
    text: "Hello room",
    fragments: ["text"],
    self: true,
    replyToId: "parent",
  });
});
