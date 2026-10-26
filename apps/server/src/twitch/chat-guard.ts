import type { Logger } from "pino";
import { type Clock, systemClock } from "../clock.js";

export class ChatGuard {
  private readonly sent = new Map<string, number>();
  constructor(
    private readonly log: Logger,
    private readonly clock: Clock = systemClock,
  ) {}
  reserve(text: string): boolean {
    const now = this.clock.now();
    for (const [key, at] of this.sent) if (now - at >= 30_000) this.sent.delete(key);
    const normalized = text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    if (this.sent.has(normalized)) {
      this.log.info("Duplicate chat message suppressed locally");
      return false;
    }
    // Reserve before I/O; a lost response must not cause the same line to be posted twice.
    this.sent.set(normalized, now);
    return true;
  }
}
