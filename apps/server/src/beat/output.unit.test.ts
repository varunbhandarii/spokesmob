import { expect, test, vi } from "vitest";
import { createLogger } from "../log.js";
import { HelixError } from "../twitch/helix.js";
import { ChatOutput, type OutputHelix } from "./output.js";

test("unpin can recover the existing pin after restart, tolerates expiry and never retries a failed write", async () => {
  const helix: OutputHelix = {
    sendChatMessage: vi.fn(async () => {
      throw new HelixError(503, "/chat/messages");
    }),
    pinMessage: vi.fn(async () => undefined),
    getPin: vi.fn(async () => ({ message_id: "previous", broadcaster_id: "1" })),
    unpinMessage: vi.fn(async () => {
      throw new HelixError(404, "/chat/pins");
    }),
    sendAnnouncement: vi.fn(async () => {
      throw new HelixError(429, "/chat/announcements");
    }),
  };
  const output = new ChatOutput(helix, createLogger("silent"));
  await expect(output.unpin()).resolves.toBeUndefined();
  expect(helix.unpinMessage).toHaveBeenCalledExactlyOnceWith("previous");
  await expect(output.ack("Spokesmob muted")).rejects.toMatchObject({ status: 503 });
  expect(helix.sendChatMessage).toHaveBeenCalledTimes(1);
  await expect(output.announce("Name the cat?")).rejects.toMatchObject({ status: 429 });
  expect(helix.sendAnnouncement).toHaveBeenCalledExactlyOnceWith(
    "The mob is deciding: Name the cat?",
    "purple",
  );
});
