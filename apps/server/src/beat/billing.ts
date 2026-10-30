import type { Clock } from "../clock.js";
import type { ModerationPort } from "../consensus/ports.js";
import type { SpendLedger } from "../store/spend.js";

export function recordedModeration(options: {
  port: ModerationPort;
  ledger: SpendLedger;
  clock: Clock;
  beatId(): string | null;
  updated(beatId: string | null): void;
}): ModerationPort {
  return {
    async moderate(texts, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const beatId = options.beatId();
      const ticket = options.ledger.reserve("moderation", options.clock.now(), beatId, 0);
      if (!ticket) throw new Error("Moderation admission unavailable");
      try {
        const response = await options.port.moderate(texts, signal);
        options.ledger.settle(ticket, response.costUsd ?? null, response.usage);
        return response;
      } finally {
        options.updated(beatId);
      }
    },
  };
}
