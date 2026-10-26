import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { createLogger } from "../log.js";
import { collectEvents, TwitchBus } from "./bus.js";
import { chatSchema, mapNotification } from "./events.js";

const log = createLogger("silent");
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/observed-events.json", import.meta.url), "utf8"),
) as Record<string, unknown>[];
const frame = (type: string, event: unknown) => ({
  metadata: {
    message_id: "frame",
    message_type: "notification",
    message_timestamp: "2026-01-01T00:00:00Z",
    subscription_type: type,
  },
  payload: { event },
});
const chat = () =>
  structuredClone((fixtures[0] as { payload: { event: Record<string, unknown> } }).payload.event);

test("captured event structures with synthetic identities and text map to stable events", () => {
  const output = fixtures.map((fixture) => mapNotification(fixture, "900000001", log));
  expect(output.every(Boolean)).toBe(true);
  expect(output).toMatchSnapshot();
});

test("all Hype Train stages retain shared state and optional progress", () => {
  const events = ["begin", "progress", "end"].map((stage) =>
    mapNotification(
      frame(`channel.hype_train.${stage}`, {
        broadcaster_user_id: "1",
        id: "train",
        level: 2,
        total: 1200,
        is_shared_train: true,
        type: "regular",
        ...(stage === "end"
          ? {}
          : { progress: 200, goal: 1000, expires_at: "2026-01-01T00:05:00Z" }),
      }),
      "1",
      log,
    ),
  );
  expect(events).toMatchSnapshot();
});

test("chat normalizes colors and subscriber months while preserving future fields and message types", () => {
  const value = {
    ...chat(),
    chatter_user_id: "self",
    color: "",
    badges: [
      { set_id: "vip", id: "1", info: "999" },
      { set_id: "subscriber", id: "6", info: "12" },
    ],
    message_type: "future_effect",
    future_field: { enabled: true },
  };
  expect(chatSchema.parse(value).future_field).toEqual({ enabled: true });
  expect(mapNotification(frame("channel.chat.message", value), "self", log)).toMatchObject({
    self: true,
    messageType: "future_effect",
    author: { color: null, subscriber: true, vip: true, subMonths: 12 },
  });
  value.badges = [{ set_id: "vip", id: "1", info: "999" }];
  expect(mapNotification(frame("channel.chat.message", value), "other", log)).not.toHaveProperty(
    "author.subMonths",
  );
});

test("both GIF identifiers, cheermotes, replies and source fields map", () => {
  for (const key of ["gif_id", "id"]) {
    const value = {
      ...chat(),
      message: {
        text: "gif Cheer100",
        fragments: [
          {
            type: "gif",
            text: "gif",
            gif: { [key]: "gif-example", url: "https://example.invalid/gif" },
          },
          { type: "cheermote", text: "Cheer100", cheermote: { bits: 100 } },
        ],
      },
      reply: { parent_message_id: "parent" },
      source_broadcaster_user_id: "source-channel",
      source_broadcaster_user_login: "source_demo",
      source_message_id: "source-message",
      is_source_only: true,
    };
    expect(mapNotification(frame("channel.chat.message", value), "other", log)).toMatchObject({
      replyToId: "parent",
      source: {
        channelId: "source-channel",
        login: "source_demo",
        messageId: "source-message",
        sourceOnly: true,
      },
      fragments: [
        { type: "gif", gifId: "gif-example" },
        { type: "cheermote", bits: 100 },
      ],
    });
  }
});

test("notices preserve unknown notice data and omit anonymous identities", () => {
  const event = mapNotification(
    frame("channel.chat.notification", {
      broadcaster_user_id: "1",
      notice_type: "watch_streak",
      chatter_is_anonymous: true,
      chatter_user_id: "hidden",
      chatter_user_name: "Hidden",
      watch_streak: { streak: 5, future: true },
    }),
    "1",
    log,
  );
  expect(event).toEqual({
    kind: "notice",
    at: "2026-01-01T00:00:00Z",
    noticeType: "watch_streak",
    anonymous: true,
    data: { streak: 5, future: true },
  });
});

test("unknown subscription types are ignored and malformed payloads are logged without their contents", () => {
  const lines: string[] = [];
  const logger = createLogger("warn", {
    write: (line: string) => {
      lines.push(line);
    },
  });
  expect(mapNotification(frame("future.type", {}), "1", logger)).toBeNull();
  expect(lines).toHaveLength(0);
  expect(
    mapNotification(frame("channel.chat.message", { secret: "private-payload" }), "1", logger),
  ).toBeNull();
  expect(mapNotification({ metadata: {} }, "1", logger)).toBeNull();
  expect(lines).toHaveLength(2);
  expect(lines.join("")).not.toContain("private-payload");
});

test("typed bus listeners and health collectors unsubscribe independently", () => {
  const bus = new TwitchBus();
  const collector = collectEvents(bus);
  let messages = 0;
  const stop = bus.on("stream", (event) => {
    if (event.online) messages++;
  });
  bus.emit({ kind: "stream", online: true, at: "now" });
  bus.health({ kind: "auth", state: "auth_required" });
  stop();
  bus.emit({ kind: "stream", online: true, at: "later" });
  collector.stop();
  bus.emit({ kind: "stream", online: false, at: "end" });
  expect(messages).toBe(1);
  expect(collector.events).toHaveLength(2);
  expect(collector.health).toEqual([{ kind: "auth", state: "auth_required" }]);
});
