import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { fromTwitchChat, normalizeMessage } from "../../../../packages/core/src/normalize.js";
import { createLogger } from "../log.js";
import { mapNotification } from "../twitch/events.js";

test("a captured chat structure becomes a pure chat message with the expected key", () => {
  const fixtures = JSON.parse(
    readFileSync(new URL("../twitch/fixtures/observed-events.json", import.meta.url), "utf8"),
  ) as unknown[];
  const event = mapNotification(fixtures[0], "900000001", createLogger("silent"));
  if (event?.kind !== "chat") throw new Error("Expected a chat fixture");
  const message = fromTwitchChat(event);
  expect(message.authorId).toBe(event.author.id);
  expect(message.weight).toBe(1);
  expect(message.flags.self).toBe(event.self);
  expect(normalizeMessage(message).key).toBe("helo rom");
});
