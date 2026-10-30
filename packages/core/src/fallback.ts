import { band } from "./agreement.js";
import type { Blocklist } from "./blocklist.js";
import { fold } from "./normalize.js";
import { THRESHOLDS } from "./thresholds.js";
import type { Cluster, ConsensusOutput, RuleCode } from "./types.js";

/** These payload forms cannot safely be repeated when the model is unavailable. */
export function isInstructionPayload(text: string): boolean {
  const value = fold(text);
  return (
    /\b(?:ignore|disregard|forget|override)\b.{0,60}\b(?:instructions?|rules?|prompts?|system|previous)\b/u.test(
      value,
    ) ||
    /(?:^|\s)(?:system|developer|assistant)\s*:/u.test(value) ||
    /\b(?:you are now|act as|pretend to be)\b/u.test(value) ||
    /\b(?:reveal|print|show|leak|read|say)\b.{0,40}\b(?:secrets?|api[ _-]?key|system prompt|address)\b/u.test(
      value,
    ) ||
    /\b(?:say|repeat|output|respond with|read aloud)\s+(?:exactly|only|the word)\b/u.test(value)
  );
}

export type Fallback = { output: ConsensusOutput; clusterKey: string } | { reason: RuleCode };
export function fallbackLine(
  clusters: readonly Cluster[],
  voices: number,
  options: {
    blocklist: Blocklist;
    minVoices?: number;
  },
): Fallback {
  const top = clusters[0];
  if (
    !top ||
    top.authorCount <
      Math.max(
        options.minVoices ?? THRESHOLDS.MIN_VOICES,
        Math.ceil(THRESHOLDS.SUPPORT_FRACTION * voices),
      )
  )
    return { reason: "support_low" };
  const forms = new Map<string, number>();
  for (const bucket of top.buckets)
    for (const message of bucket.messages) {
      if (message.clean && !options.blocklist.check(message.clean).blocked) {
        forms.set(message.clean, (forms.get(message.clean) ?? 0) + 1);
      }
    }
  const form = [...forms].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )[0]?.[0];
  if (!form) return { reason: "blocked_term" };
  // Inspect the full candidate before clipping, so a late payload cannot escape detection.
  if (isInstructionPayload(form)) return { reason: "instruction_payload" };
  const words = [...new Intl.Segmenter("und", { granularity: "word" }).segment(form)].filter(
    (item) => item.isWordLike,
  );
  const end = words[7];
  let phrase = words.length > 8 && end ? form.slice(0, end.index + end.segment.length) : form;
  if (/[^\p{Script=Latin}\p{M}\p{N}\p{P}\p{Z}]/u.test(phrase)) phrase = `‘${phrase}’`;
  const prefix = { most: "Most", a_lot: "A lot", some: "Some" }[band(top.authorCount / voices)];
  return {
    output: {
      line: voices <= 3 ? `Chat says ${phrase}` : `${prefix} of chat says ${phrase}`,
      alternate_line: null,
      cited_cluster_ids: [top.id],
      dissent_cluster_id: null,
      dissent_line: null,
      mood: "chill",
      answers_question: false,
    },
    clusterKey: top.key,
  };
}
