import type { Logger } from "pino";
import { type Blocklist, createBlocklist } from "../../../../packages/core/src/blocklist.js";
import { type Clock, systemClock } from "../clock.js";
import type { BlockedTerm } from "../twitch/helix.js";

export class ChannelBlocklist implements Blocklist {
  private current = createBlocklist();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private refreshing = false;
  private readonly clock: Clock;

  constructor(
    private readonly options: {
      helix: { getBlockedTerms(): Promise<BlockedTerm[]> };
      log: Pick<Logger, "warn">;
      clock?: Clock;
    },
  ) {
    this.clock = options.clock ?? systemClock;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
    if (!this.stopped && !this.timer) {
      this.timer = this.clock.setInterval(() => void this.refresh(), 10 * 60_000);
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const terms = await this.options.helix.getBlockedTerms();
      const replacement = createBlocklist({ channelTerms: terms.map((term) => term.text) });
      if (!this.stopped) this.current = replacement;
    } catch {
      this.options.log.warn(
        "Channel blocked terms unavailable; keeping existing speech protection",
      );
    } finally {
      this.refreshing = false;
    }
  }

  check(text: string): ReturnType<Blocklist["check"]> {
    return this.current.check(text);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clock.clearInterval(this.timer);
    this.timer = undefined;
  }
}
