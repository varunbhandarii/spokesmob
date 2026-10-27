import { createHash } from "node:crypto";
import { z } from "zod";
import type { CallUsage } from "../../../../packages/core/src/types.js";
import { type Clock, systemClock } from "../clock.js";
import type { ModerationPort, ModerationResult } from "./ports.js";

const resultSchema = z.object({
  flagged: z.boolean(),
  categories: z.record(z.string(), z.boolean()),
  scores: z.record(z.string(), z.number().min(0).max(1)),
});
export class ModerationFailure extends Error {
  constructor(readonly reason: "moderation_unavailable" | "moderation_mapping" | "aborted") {
    super(reason);
  }
}
export function moderationDecision(result: ModerationResult): "allow" | "drop" | "skip" {
  if ((result.scores.harassment ?? 1) >= 0.8 || (result.scores.sexual ?? 1) >= 0.8) return "skip";
  const flags = Object.entries(result.categories)
    .filter(([, flagged]) => flagged)
    .map(([name]) => name);
  if (flags.some((name) => name !== "harassment" && name !== "sexual")) return "skip";
  if (result.flagged && !flags.length) return "skip";
  return flags.length ? "drop" : "allow";
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class ModerationGate {
  private readonly cache = new Map<string, { at: number; result: ModerationResult }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly usage: CallUsage[] = [];
  private readonly clock: Clock;
  constructor(
    private readonly options: {
      port: ModerationPort;
      clock?: Clock;
      onUsage?: (usage: CallUsage) => void;
    },
  ) {
    this.clock = options.clock ?? systemClock;
  }
  get cacheSize(): number {
    return this.cache.size;
  }
  drainUsage(): CallUsage[] {
    return this.usage.splice(0);
  }
  async premoderate(texts: readonly string[], signal?: AbortSignal): Promise<void> {
    await this.resolve(texts, signal);
  }
  async resolve(
    texts: readonly string[],
    signal?: AbortSignal,
  ): Promise<Map<string, ModerationResult>> {
    if (signal?.aborted) throw new ModerationFailure("aborted");
    for (const [key, value] of this.cache)
      if (this.clock.now() - value.at >= 15 * 60_000) this.cache.delete(key);
    const unique = [...new Set(texts)];
    const missing = unique.filter(
      (text) => !this.cache.has(hash(text)) && !this.pending.has(hash(text)),
    );
    for (let index = 0; index < missing.length; index += 36) {
      const batch = missing.slice(index, index + 36);
      const promise = this.load(batch, signal);
      for (const text of batch) this.pending.set(hash(text), promise);
      // Every promise has a handler even when a caller aborts before awaiting it.
      void promise.catch(() => undefined);
    }
    await Promise.all(unique.map((text) => this.pending.get(hash(text))));
    if (signal?.aborted) throw new ModerationFailure("aborted");
    const mapped = new Map<string, ModerationResult>();
    for (const text of unique) {
      const result = this.cache.get(hash(text));
      if (!result) throw new ModerationFailure("moderation_mapping");
      mapped.set(text, result.result);
    }
    return mapped;
  }
  private async attempt(texts: readonly string[], timeout: number, signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let usage: CallUsage = {
      source: "input_moderation",
      usage: null,
      serviceTier: "default",
      costUsd: null,
    };
    try {
      const response = await Promise.race([
        this.options.port.moderate(texts, controller.signal),
        new Promise<never>((_, reject) => {
          timer = this.clock.setTimeout(() => {
            controller.abort();
            reject(new Error("Moderation deadline"));
          }, timeout);
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Moderation aborted")),
            { once: true },
          );
        }),
      ]);
      usage = { ...usage, usage: response.usage };
      if (!Array.isArray(response.results) || response.results.length !== texts.length)
        throw new ModerationFailure("moderation_mapping");
      const parsed = response.results.map((item) => resultSchema.safeParse(item));
      if (
        parsed.some(
          (item) =>
            !item.success ||
            Object.keys(item.data.categories).length === 0 ||
            item.data.scores.harassment === undefined ||
            item.data.scores.sexual === undefined,
        )
      ) {
        throw new ModerationFailure("moderation_mapping");
      }
      return response.results;
    } finally {
      if (timer) this.clock.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      this.usage.push(usage);
      this.options.onUsage?.(usage);
    }
  }
  private async load(texts: readonly string[], signal?: AbortSignal): Promise<void> {
    const start = this.clock.now();
    try {
      let results: ModerationResult[];
      try {
        results = await this.attempt(texts, 6000, signal);
      } catch (error) {
        if (signal?.aborted) throw new ModerationFailure("aborted");
        if (error instanceof ModerationFailure) throw error;
        const remaining = 500 - (this.clock.now() - start);
        if (remaining <= 0) throw new ModerationFailure("moderation_unavailable");
        try {
          results = await this.attempt(texts, remaining, signal);
        } catch (retryError) {
          if (signal?.aborted) throw new ModerationFailure("aborted");
          throw retryError instanceof ModerationFailure
            ? retryError
            : new ModerationFailure("moderation_unavailable");
        }
      }
      if (signal?.aborted) throw new ModerationFailure("aborted");
      texts.forEach((text, index) => {
        const result = results[index];
        if (result) this.cache.set(hash(text), { at: this.clock.now(), result });
      });
      while (this.cache.size > 5000) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
    } finally {
      for (const text of texts) this.pending.delete(hash(text));
    }
  }
}
