import { createHash } from "node:crypto";
import { OpenAI } from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  type BuiltInput,
  promptMessages,
  STATIC_PREFIX,
} from "../../../../packages/core/src/prompt.js";
import { consensusOutputSchema } from "../../../../packages/core/src/schema.js";
import type { ModelUsage, RuleCode } from "../../../../packages/core/src/types.js";
import type { OutputModeration } from "../../../../packages/core/src/verify.js";
import { type Clock, systemClock } from "../clock.js";
import type { ConsensusModelPort, ModelResult, ModerationPort } from "./ports.js";

const usageSchema = z.object({
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  input_tokens_details: z.object({
    cached_tokens: z.number().nonnegative(),
    cache_write_tokens: z.number().nonnegative().optional(),
  }),
});
function mapUsage(raw: unknown): ModelUsage | null {
  const parsed = usageSchema.safeParse(raw);
  if (!parsed.success) return null;
  const usage = parsed.data;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedTokens: usage.input_tokens_details.cached_tokens,
    ...(usage.input_tokens_details.cache_write_tokens !== undefined
      ? { cacheWriteTokens: usage.input_tokens_details.cache_write_tokens }
      : {}),
  };
}
const inlineSchema = z.object({ type: z.literal("moderation_result"), flagged: z.boolean() });
function inlineResult(raw: unknown): OutputModeration {
  const parsed = inlineSchema.safeParse(raw);
  return parsed.success ? { status: "ok", flagged: parsed.data.flagged } : { status: "error" };
}
export class OpenAIConsensusModel implements ConsensusModelPort {
  private readonly clock: Clock;
  constructor(
    private readonly options: { client: OpenAI; serviceTier: "default" | "fast"; clock?: Clock },
  ) {
    this.clock = options.clock ?? systemClock;
  }
  async generate(input: BuiltInput, signal?: AbortSignal): Promise<ModelResult> {
    const start = this.clock.now();
    try {
      const response = await this.options.client.responses.parse(
        {
          model: "gpt-6-luna",
          reasoning: { effort: "none" },
          store: false,
          max_output_tokens: 256,
          moderation: { model: "omni-moderation-latest" },
          prompt_cache_key: "spokesmob:deadpan",
          service_tier: this.options.serviceTier,
          input: promptMessages(input),
          text: { format: zodTextFormat(consensusOutputSchema, "consensus") },
        },
        { ...(signal ? { signal } : {}), timeout: 6000, maxRetries: 0 },
      );
      const refused = response.output.some(
        (item) => item.type === "message" && item.content.some((part) => part.type === "refusal"),
      );
      const parsed = consensusOutputSchema.safeParse(response.output_parsed);
      const failure: RuleCode | null = refused
        ? "refusal"
        : response.status !== "completed"
          ? "incomplete"
          : !parsed.success
            ? "schema_invalid"
            : null;
      return {
        output: parsed.success ? parsed.data : null,
        failure,
        inputModeration: inlineResult(response.moderation?.input),
        outputModeration: inlineResult(response.moderation?.output),
        usage: mapUsage(response.usage),
        latencyMs: this.clock.now() - start,
        ...(response.status === "incomplete"
          ? { incompleteReason: response.incomplete_details?.reason ?? null }
          : {}),
      };
    } catch (error) {
      const failure: RuleCode = signal?.aborted
        ? "aborted"
        : error instanceof OpenAI.APIConnectionTimeoutError
          ? "model_timeout"
          : error instanceof OpenAI.RateLimitError
            ? "model_rate_limit"
            : error instanceof z.ZodError || error instanceof SyntaxError
              ? "schema_invalid"
              : "model_error";
      // Transport errors may omit usage. Never infer a free failed attempt.
      const usage =
        typeof error === "object" && error !== null && "usage" in error
          ? mapUsage(error.usage)
          : null;
      return {
        output: null,
        failure,
        inputModeration: { status: "error" },
        outputModeration: { status: "error" },
        usage,
        latencyMs: this.clock.now() - start,
      };
    }
  }
  async countPrefix(signal?: AbortSignal): Promise<{ tokens: number; sha256: string }> {
    const result = await this.options.client.responses.inputTokens.count(
      {
        model: "gpt-6-luna",
        input: [{ role: "developer", content: STATIC_PREFIX }],
        reasoning: { effort: "none" },
        text: { format: zodTextFormat(consensusOutputSchema, "consensus") },
      },
      { ...(signal ? { signal } : {}), timeout: 6000, maxRetries: 0 },
    );
    return {
      tokens: result.input_tokens,
      sha256: createHash("sha256").update(STATIC_PREFIX).digest("hex"),
    };
  }
}

export class OpenAIModerationPort implements ModerationPort {
  constructor(private readonly client: OpenAI) {}
  async moderate(texts: readonly string[], signal?: AbortSignal) {
    const response = await this.client.moderations.create(
      { model: "omni-moderation-latest", input: [...texts] },
      { ...(signal ? { signal } : {}), timeout: 6000, maxRetries: 0 },
    );
    return {
      results: response.results.map((item) => ({
        flagged: item.flagged,
        categories: Object.fromEntries(
          Object.entries(item.categories).flatMap(([key, value]) =>
            typeof value === "boolean" ? [[key, value] as const] : [],
          ),
        ),
        scores: Object.fromEntries(
          Object.entries(item.category_scores).flatMap(([key, value]) =>
            typeof value === "number" ? [[key, value] as const] : [],
          ),
        ),
      })),
      usage: null,
    };
  }
}
