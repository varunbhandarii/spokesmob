import { expect, test, vi } from "vitest";
import { createLogger } from "../log.js";
import { HelixError } from "../twitch/helix.js";
import { ChatOutput, type OutputHelix } from "./output.js";

test("a pin that completes after mute is removed without posting or pinning again", async () => {
  let finish!: () => void;
  const helix: OutputHelix = {
    sendChatMessage: vi.fn(),
    pinMessage: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
    getPin: vi.fn(async () => null),
    unpinMessage: vi.fn(async () => {}),
    sendAnnouncement: vi.fn(),
  };
  const output = new ChatOutput(helix, createLogger("silent"));
  const pending = output.pin("new-message", 60);
  await output.unpin();
  finish();
  await pending;
  expect(helix.unpinMessage).toHaveBeenCalledExactlyOnceWith("new-message");
  expect(helix.pinMessage).toHaveBeenCalledTimes(1);
  expect(helix.sendChatMessage).not.toHaveBeenCalled();
});

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
