import { z } from "zod";
import { MOODS, type RuleCode } from "./types.js";

export const CLUSTER_IDS = [
  "c1",
  "c2",
  "c3",
  "c4",
  "c5",
  "c6",
  "c7",
  "c8",
  "c9",
  "c10",
  "c11",
  "c12",
] as const;
const clusterId = z.enum(CLUSTER_IDS);
export const ruleCodeSchema = z.enum([
  "schema_invalid",
  "refusal",
  "incomplete",
  "cited_missing",
  "cited_duplicate",
  "support_low",
  "too_long",
  "pattern_banned",
  "username_banned",
  "blocked_term",
  "majority_word",
  "novel_token",
  "dissent_unsupported",
  "moderation_flagged",
  "moderation_error",
  "near_duplicate",
  "not_enough_voices",
  "input_moderation",
  "moderation_mapping",
  "moderation_drop_limit",
  "model_timeout",
  "model_rate_limit",
  "model_error",
  "aborted",
] satisfies RuleCode[]);

export const consensusOutputSchema = z.strictObject({
  line: z.string(),
  cited_cluster_ids: z.array(clusterId).min(1).max(4),
  dissent_cluster_id: clusterId.nullable(),
  dissent_line: z.string().nullable(),
  mood: z.enum(MOODS),
  answers_question: z.boolean(),
});

export const consensusInputSchema = z.strictObject({
  question: z.string().nullable(),
  voices: z.number().int().nonnegative(),
  share_bands: z.strictObject({ most: z.string(), a_lot: z.string(), some: z.string() }),
  mood_signals: z.strictObject({
    laugh_authors: z.number().int().nonnegative(),
    emote_authors: z.number().int().nonnegative(),
    raid_active: z.boolean(),
    hype_level: z.number().nonnegative(),
  }),
  clusters: z
    .array(
      z.strictObject({
        id: clusterId,
        authors: z.number().int().nonnegative(),
        share: z.number().min(0).max(1),
        exemplars: z.array(z.string()).max(3),
      }),
    )
    .max(12),
  previous_attempt_rejected: ruleCodeSchema.optional(),
});

export const synthesisResultSchema = z.strictObject({
  status: z.enum(["verified", "suppressed"]),
  line: z.string().nullable(),
  dissent: z.string().nullable(),
  citedClusterKeys: z.array(z.string()),
  pct: z.number().int().min(0).max(100),
  voices: z.number().int().nonnegative(),
  citedAuthors: z.array(z.string()),
  citedNames: z.array(z.string()),
  mood: z.enum(MOODS).nullable(),
  answersQuestion: z.boolean(),
  fallback: z.boolean(),
  attempts: z.number().int().nonnegative(),
  gate: z
    .enum(["intake", "input_moderation", "model", "verification", "output_moderation", "aborted"])
    .nullable(),
  reason: ruleCodeSchema.nullable(),
  latency: z.strictObject({
    assembly: z.number().nonnegative(),
    clustering: z.number().nonnegative(),
    inputModeration: z.number().nonnegative(),
    model: z.number().nonnegative(),
    verification: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
  usage: z.array(
    z.strictObject({
      source: z.enum(["model", "output_moderation", "input_moderation"]),
      usage: z
        .strictObject({
          inputTokens: z.number().nonnegative(),
          outputTokens: z.number().nonnegative(),
          cachedTokens: z.number().nonnegative(),
          cacheWriteTokens: z.number().nonnegative().optional(),
        })
        .nullable(),
      serviceTier: z.enum(["default", "fast"]),
      costUsd: z.number().nonnegative().nullable(),
    }),
  ),
  costUsd: z.number().nonnegative().nullable(),
});
