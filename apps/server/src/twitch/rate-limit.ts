import { type Clock, sleep, systemClock } from "../clock.js";

export type RateClass = "general" | "chat" | "announce";
const limits = {
  general: { count: 600, window: 60_000 },
  chat: { count: 60, window: 30_000 },
  announce: { count: 1, window: 2500 },
};

export class RateLimiter {
  private readonly history: Record<RateClass, number[]> = { general: [], chat: [], announce: [] };
  private queue: Promise<void> = Promise.resolve();
  private pausedUntil = 0;
  private generalLimit = 600;
  constructor(private readonly clock: Clock = systemClock) {}

  acquire(kind: RateClass = "general"): Promise<void> {
    const operation = this.queue.then(async () => {
      const classes: RateClass[] = kind === "general" ? ["general"] : ["general", kind];
      for (;;) {
        const now = this.clock.now();
        let available = Math.max(now, this.pausedUntil);
        for (const name of classes) {
          const limit = limits[name];
          const history = this.history[name];
          while (history.length && (history[0] ?? 0) <= now - limit.window) history.shift();
          const count = name === "general" ? this.generalLimit : limit.count;
          if (history.length >= count)
            available = Math.max(
              available,
              (history[history.length - count] ?? now) + limit.window,
            );
        }
        if (available <= now) {
          for (const name of classes) this.history[name].push(now);
          return;
        }
        await sleep(this.clock, available - now);
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  observe(headers: Headers): void {
    const limit = Number(headers.get("ratelimit-limit"));
    if (Number.isFinite(limit) && limit > 0) this.generalLimit = Math.min(600, Math.floor(limit));
    if (headers.get("ratelimit-remaining") === "0")
      this.pauseUntil(resetTime(headers, this.clock.now()));
  }

  pauseUntil(time: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, time);
  }
}

export function resetTime(headers: Headers, now: number): number {
  const reset = Number(headers.get("ratelimit-reset"));
  return reset > 0 && Number.isFinite(reset) ? Math.max(now, reset * 1000) : now + 1000;
}
