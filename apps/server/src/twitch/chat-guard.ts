import type { Logger } from "pino";
import { type Clock, systemClock } from "../clock.js";

export class ChatGuard {
  private readonly sent = new Map<string, { at: number; pending: boolean }>();
  constructor(
    private readonly log: Logger,
    private readonly clock: Clock = systemClock,
  ) {}
  reserve(text: string): boolean {
    const now = this.clock.now();
    for (const [key, value] of this.sent)
      if (!value.pending && now - value.at >= 30_000) this.sent.delete(key);
    const normalized = text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    if (this.sent.has(normalized)) {
      this.log.info("Duplicate chat message suppressed locally");
      return false;
    }
    // Reserve before I/O; a lost response must not cause the same line to be posted twice.
    this.sent.set(normalized, { at: now, pending: true });
    return true;
  }

  complete(text: string): void {
    const normalized = text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    this.sent.set(normalized, { at: this.clock.now(), pending: false });
  }
}
