import type { Logger } from "pino";
import type { BeatLine } from "../../../../packages/core/src/beat-types.js";
import { formatAnnouncement, formatPost } from "../../../../packages/core/src/chat-output.js";
import { type ChatResult, type HelixClient, HelixError } from "../twitch/helix.js";

export type OutputHelix = Pick<
  HelixClient,
  "sendChatMessage" | "pinMessage" | "getPin" | "unpinMessage" | "sendAnnouncement"
>;
export class ChatOutput {
  private currentPin: string | null = null;
  constructor(
    private readonly helix: OutputHelix,
    private readonly log: Pick<Logger, "warn">,
  ) {}
  async post(line: BeatLine): Promise<ChatResult> {
    const text = formatPost(line);
    if (!text) {
      this.log.warn({ reason: "message_too_long" }, "Beat post suppressed");
      return { messageId: null, sent: false, dropReason: "message_too_long", suppressed: true };
    }
    return this.helix.sendChatMessage({ text });
  }
  async pin(messageId: string, seconds: number) {
    await this.helix.pinMessage(messageId, seconds);
    this.currentPin = messageId;
  }
  async unpin() {
    try {
      const id = this.currentPin ?? (await this.helix.getPin())?.message_id;
      if (id) await this.helix.unpinMessage(id);
      this.currentPin = null;
    } catch (error) {
      if (error instanceof HelixError && error.status === 404) this.currentPin = null;
      else throw error;
    }
  }
  async ack(text: string) {
    return this.helix.sendChatMessage({ text });
  }
  async announce(question: string) {
    await this.helix.sendAnnouncement(formatAnnouncement(question), "purple");
  }
}
