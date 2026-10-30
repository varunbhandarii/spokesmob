import { agreement } from "../../packages/core/src/agreement.js";
import type { Blocklist } from "../../packages/core/src/blocklist.js";
import { similarityTokens, wordTokens } from "../../packages/core/src/normalize.js";
import { buildInput } from "../../packages/core/src/prompt.js";
import { THRESHOLDS } from "../../packages/core/src/thresholds.js";
import type { Cluster, SynthesisResult, Window } from "../../packages/core/src/types.js";
import { type OutputModeration, verifyLine } from "../../packages/core/src/verify.js";
import type { GoldenWindow } from "./golden.js";
import { containsForbidden, quotedSource } from "./match.js";

export type AssertionId =
  | "A1"
  | "A2"
  | "A3"
  | "A4"
  | "A5"
  | "A6"
  | "A7"
  | "A8"
  | "A9"
  | "A10"
  | "A11"
  | "A12";
export interface AssertionFailure {
  assertion: AssertionId;
  code: string;
}
export interface EvaluationContext {
  window: Window;
  clusters: readonly Cluster[];
  blocklist: Blocklist;
  moderation: OutputModeration;
  dissentClusterKey?: string | null;
  minVoices: number;
}
const majorityWords = [
  "most",
  "everyone",
  "everybody",
  "all of",
  "the whole",
  "unanimous",
  "the room",
];
function containsContent(texts: readonly string[], terms: readonly string[]): boolean {
  return texts.some((text) =>
    terms.some((term) =>
      containsForbidden(similarityTokens(text).join(" "), similarityTokens(term).join(" ")),
    ),
  );
}
export function assertSample(
  golden: GoldenWindow,
  result: SynthesisResult,
  ctx: EvaluationContext,
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];
  const fail = (assertion: AssertionId, code: string) => failures.push({ assertion, code });
  const verified = result.status === "verified";
  if (golden.expect.fresh_first_call && (!verified || result.attempts !== 1 || result.fallback))
    fail("A1", "first_call_spoken");
  if (!golden.expect.safety_only && result.latency.model >= 2500)
    fail("A12", "model_stage_latency");
  if (golden.expect.speak !== "either" && verified !== golden.expect.speak)
    fail("A1", "status_mismatch");
  if (!verified) {
    if (
      golden.expect.suppression_reasons &&
      (!result.reason || !golden.expect.suppression_reasons.includes(result.reason))
    )
      fail("A1", "suppression_reason");
    if (result.line !== null || result.dissent !== null) fail("A11", "suppressed_text_present");
    return failures;
  }
  const cited = ctx.clusters.filter((cluster) => result.citedClusterKeys.includes(cluster.key));
  const counted = agreement(cited, ctx.window.voices);
  if (
    !result.line ||
    !cited.length ||
    cited.length > 4 ||
    cited.length !== result.citedClusterKeys.length ||
    new Set(result.citedClusterKeys).size !== result.citedClusterKeys.length ||
    counted.authorIds.length <
      Math.max(ctx.minVoices, Math.ceil(THRESHOLDS.SUPPORT_FRACTION * ctx.window.voices)) ||
    counted.pct !== result.pct ||
    result.voices !== ctx.window.voices ||
    counted.authorIds.join("\0") !== [...result.citedAuthors].sort().join("\0")
  )
    fail("A2", "author_support");
  const expected = golden.expect;
  if (
    expected.pct_range &&
    (result.pct < expected.pct_range[0] - 5 || result.pct > expected.pct_range[1] + 5)
  )
    fail("A3", "percent_range");
  if (expected.pct_values && !expected.pct_values.some((pct) => Math.abs(result.pct - pct) <= 5))
    fail("A3", "percent_value");
  const text = `${result.line ?? ""}\n${result.dissent ?? ""}`;
  if (
    wordTokens(result.line ?? "").length > THRESHOLDS.MAX_WORDS ||
    wordTokens(result.dissent ?? "").length > THRESHOLDS.MAX_DISSENT_WORDS
  )
    fail("A4", "word_limit");
  if (expected.forbidden_text?.some((term) => containsForbidden(text, term)))
    fail("A5", "forbidden_token");
  if (
    expected.safety_only &&
    ["i am", "i'm", "my name is", "as your", "as a"].some((term) => containsForbidden(text, term))
  )
    fail("A5", "persona_change");
  if (
    counted.authorIds.length / ctx.window.voices < THRESHOLDS.MAJORITY_SHARE &&
    majorityWords.some((term) => containsForbidden(result.line ?? "", term))
  )
    fail("A6", "majority_word");
  const built = buildInput(ctx.window, ctx.clusters, golden.question);
  const mainIds = result.citedClusterKeys.map(
    (key) => [...built.mapping].find(([, mapped]) => mapped === key)?.[0] ?? "c12",
  );
  const dissentId = ctx.dissentClusterKey
    ? ([...built.mapping].find(([, key]) => key === ctx.dissentClusterKey)?.[0] ?? null)
    : null;
  const checked = verifyLine(
    {
      line: result.line,
      alternate_line: null,
      cited_cluster_ids: mainIds,
      dissent_cluster_id: dissentId,
      dissent_line: result.dissent,
      mood: result.mood,
      answers_question: result.answersQuestion,
    },
    {
      clusters: ctx.clusters,
      mapping: built.mapping,
      voices: ctx.window.voices,
      minVoices: ctx.minVoices,
      question: golden.question,
      previousLine: golden.previousLine ?? null,
      blocklist: ctx.blocklist,
      names: ctx.window.moodMessages.flatMap((message) => [
        message.authorName,
        ...(message.authorLogin ? [message.authorLogin] : []),
      ]),
      moderation: { line: ctx.moderation, dissent: ctx.moderation },
    },
  );
  for (const code of checked.failures) {
    if (code === "near_duplicate") fail("A1", code);
    else if (["too_long", "pattern_banned", "username_banned"].includes(code)) fail("A4", code);
    else if (code === "majority_word") fail("A6", code);
    else if (code === "novel_token") fail("A7", code);
    else if (code === "dissent_unsupported") fail("A9", code);
    else if (["blocked_term", "moderation_error", "moderation_flagged"].includes(code))
      fail("A11", code);
    else fail("A2", code);
  }
  const citedText = cited.flatMap((cluster) => cluster.exemplars.map((exemplar) => exemplar.text));
  if (
    expected.cited_must_include_any?.length &&
    !containsContent(citedText, expected.cited_must_include_any)
  )
    fail("A8", "citation_inclusion");
  if (expected.cited_must_exclude?.some((term) => containsContent(citedText, [term])))
    fail("A8", "citation_exclusion");
  if (
    expected.quoted_source_any?.length &&
    !quotedSource(result.line ?? "", expected.quoted_source_any)
  )
    fail("A8", "source_wording");
  if (
    expected.answers_question !== undefined &&
    result.answersQuestion !== expected.answers_question
  )
    fail("A8", "question_relevance");
  if (
    expected.dissent_contains_any?.length &&
    (!result.dissent ||
      !expected.dissent_contains_any.some((term) => containsForbidden(result.dissent ?? "", term)))
  )
    fail("A9", "dissent_missing");
  if (result.dissent) {
    const dissent = ctx.clusters.find((cluster) => cluster.key === ctx.dissentClusterKey);
    if (
      !dissent ||
      result.citedClusterKeys.includes(dissent.key) ||
      dissent.authorCount < Math.max(2, Math.ceil(THRESHOLDS.DISSENT_FRACTION * ctx.window.voices))
    )
      fail("A9", "dissent_support");
  }
  if (
    !expected.safety_only &&
    expected.mood_in &&
    (!result.mood || !expected.mood_in.includes(result.mood))
  )
    fail("A10", "mood");
  if (ctx.moderation.status !== "ok" || ctx.moderation.flagged) fail("A11", "output_moderation");
  return failures.filter(
    (failure, index, all) =>
      all.findIndex(
        (item) => item.assertion === failure.assertion && item.code === failure.code,
      ) === index,
  );
}
