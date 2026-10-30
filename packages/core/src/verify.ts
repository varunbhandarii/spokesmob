import { agreement } from "./agreement.js";
import type { Blocklist } from "./blocklist.js";
import { tokenJaccard } from "./cluster.js";
import { fold, similarityTokens, wordTokens } from "./normalize.js";
import { consensusOutputSchema } from "./schema.js";
import { THRESHOLDS } from "./thresholds.js";
import type { Cluster, RuleCode } from "./types.js";
import { FRAME_VOCABULARY } from "./vocabulary.js";

export type OutputModeration = { status: "ok"; flagged: boolean } | { status: "error" };
export interface VerifyContext {
  clusters: readonly Cluster[];
  mapping: ReadonlyMap<string, string>;
  voices: number;
  blocklist: Blocklist;
  question?: string | null;
  previousLine?: string | null;
  questionChanged?: boolean;
  names?: readonly string[];
  frameVocabulary?: ReadonlySet<string>;
  thresholds?: typeof THRESHOLDS;
  minVoices?: number;
  modelState?: "complete" | "refusal" | "incomplete";
  moderation: { line: OutputModeration; alternate?: OutputModeration; dissent?: OutputModeration };
}
export interface Verification {
  ok: boolean;
  line: string | null;
  dissent: string | null;
  citedAuthors: string[];
  pct: number;
  failures: RuleCode[];
  offendingTokens: { line: string[]; dissent: string[] };
}

function moderationFailure(value: OutputModeration | undefined): RuleCode | undefined {
  if (!value || value.status === "error") return "moderation_error";
  return value.flagged ? "moderation_flagged" : undefined;
}

function textFailure(text: string, maxWords: number, blocklist: Blocklist): RuleCode | undefined {
  if (wordTokens(text).length > maxWords) return "too_long";
  if (
    !text.trim() ||
    [...text].some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159);
    }) ||
    /@|https?:\/\/|www\.|\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/iu.test(
      text,
    ) ||
    new RegExp(`\\d{${THRESHOLDS.MAX_DIGIT_RUN + 1},}`, "u").test(text) ||
    /\b\d+\s+\p{L}+(?:\s+\p{L}+){0,3}\s+(?:street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|way)\b/iu.test(
      text,
    )
  ) {
    return "pattern_banned";
  }
  return blocklist.check(text).blocked ? "blocked_term" : undefined;
}

function stems(token: string): string[] {
  const base = fold(token);
  const values = [base];
  for (const suffix of ["s", "es", "ed", "ing"]) {
    if (base.length > suffix.length + 2 && base.endsWith(suffix)) {
      const root = base.slice(0, -suffix.length);
      values.push(root);
      if (suffix === "ing" || suffix === "ed") values.push(`${root}e`);
    }
  }
  return values;
}

function usernameFailure(text: string, ctx: VerifyContext): boolean {
  const names = new Set([
    ...(ctx.names ?? []),
    ...ctx.clusters.flatMap((cluster) => [
      ...cluster.names,
      ...cluster.buckets.flatMap((bucket) =>
        bucket.messages.flatMap((message) => [
          message.authorName,
          ...(message.authorLogin ? [message.authorLogin] : []),
        ]),
      ),
    ]),
  ]);
  const tokens = wordTokens(text).map(fold);
  return [...names].filter(Boolean).some((name) => {
    const target = wordTokens(name).map(fold);
    return (
      target.length > 0 &&
      tokens.some((_, index) => target.every((token, offset) => tokens[index + offset] === token))
    );
  });
}

function contentFailure(
  text: string,
  clusters: readonly Cluster[],
  share: number,
  ctx: VerifyContext,
  offendingTokens: string[],
): RuleCode | undefined {
  if (usernameFailure(text, ctx)) return "username_banned";
  if (
    share < THRESHOLDS.MAJORITY_SHARE &&
    /\b(?:most|everyone|everybody|all of|the whole|unanimous|the room)\b/iu.test(text)
  ) {
    return "majority_word";
  }
  const exemplars = clusters.flatMap((cluster) => cluster.exemplars.map((item) => item.text));
  const allowed = new Set(
    [
      ...exemplars.flatMap(wordTokens),
      ...wordTokens(ctx.question ?? ""),
      ...(ctx.frameVocabulary ?? FRAME_VOCABULARY),
    ].flatMap(stems),
  );
  for (const token of wordTokens(text)) {
    const letters = [...token].filter((char) => /\p{L}/u.test(char));
    const capitalized = /^\p{Lu}/u.test(token);
    if ((letters.length >= 6 || capitalized) && !stems(token).some((stem) => allowed.has(stem))) {
      offendingTokens.push(token);
    }
    // Script-specific words stay in source form inside quotes rather than being translated.
    if (/[^\p{Script=Latin}\p{M}\p{N}\p{P}\p{Z}]/u.test(token)) {
      if (!exemplars.some((source) => source.includes(token)) || !quotedTokens(text).has(token)) {
        if (!offendingTokens.includes(token)) offendingTokens.push(token);
      }
    }
  }
  return offendingTokens.length ? "novel_token" : undefined;
}

function quotedTokens(text: string): Set<string> {
  const matches = text.matchAll(/["'“‘「『]([^"'”’」』]+)["'”’」』]/gu);
  return new Set([...matches].flatMap((match) => wordTokens(match[1] ?? "")));
}

export function verifyTemplated(
  text: string,
  ctx: {
    blocklist: Blocklist;
    moderation: OutputModeration;
    maxWords?: number;
  },
): { ok: boolean; failures: RuleCode[] } {
  const failure =
    textFailure(text, ctx.maxWords ?? THRESHOLDS.MAX_WORDS, ctx.blocklist) ??
    moderationFailure(ctx.moderation);
  return { ok: !failure, failures: failure ? [failure] : [] };
}

export function verifyLine(output: unknown, ctx: VerifyContext): Verification {
  const offendingTokens = { line: [] as string[], dissent: [] as string[] };
  const empty = (failure: RuleCode): Verification => ({
    ok: false,
    line: null,
    dissent: null,
    citedAuthors: [],
    pct: 0,
    failures: [failure],
    offendingTokens,
  });
  const parsed = consensusOutputSchema.safeParse(output);
  if (!parsed.success) return empty("schema_invalid");
  if (ctx.modelState === "refusal") return empty("refusal");
  if (ctx.modelState === "incomplete") return empty("incomplete");
  const value = parsed.data;
  const clusters = new Map(ctx.clusters.map((cluster) => [cluster.key, cluster]));
  const cited: Cluster[] = [];
  for (const id of value.cited_cluster_ids) {
    const cluster = clusters.get(ctx.mapping.get(id) ?? "");
    if (!cluster) return empty("cited_missing");
    if (cited.includes(cluster)) return empty("cited_duplicate");
    cited.push(cluster);
  }
  const support = agreement(cited, ctx.voices);
  const limits = ctx.thresholds ?? THRESHOLDS;
  if (
    support.authorIds.length <
    Math.max(ctx.minVoices ?? limits.MIN_VOICES, Math.ceil(limits.SUPPORT_FRACTION * ctx.voices))
  )
    return empty("support_low");
  const failure =
    textFailure(value.line, limits.MAX_WORDS, ctx.blocklist) ??
    contentFailure(
      value.line,
      cited,
      support.authorIds.length / ctx.voices,
      ctx,
      offendingTokens.line,
    ) ??
    moderationFailure(ctx.moderation.line);
  if (failure) return empty(failure);
  if (
    ctx.previousLine &&
    !ctx.questionChanged &&
    tokenJaccard(similarityTokens(value.line), similarityTokens(ctx.previousLine), false) >=
      limits.NEAR_DUPLICATE
  )
    return empty("near_duplicate");
  const failures: RuleCode[] = [];
  let dissent: string | null = null;
  if (value.dissent_cluster_id !== null || value.dissent_line !== null) {
    const cluster = clusters.get(ctx.mapping.get(value.dissent_cluster_id ?? "") ?? "");
    const dissentFailure =
      !cluster ||
      cited.includes(cluster) ||
      !value.dissent_line ||
      cluster.authorCount < Math.max(2, Math.ceil(limits.DISSENT_FRACTION * ctx.voices))
        ? "dissent_unsupported"
        : (textFailure(value.dissent_line, limits.MAX_DISSENT_WORDS, ctx.blocklist) ??
          contentFailure(
            value.dissent_line,
            [cluster],
            cluster.authorCount / ctx.voices,
            ctx,
            offendingTokens.dissent,
          ) ??
          moderationFailure(ctx.moderation.dissent));
    if (dissentFailure) failures.push(dissentFailure);
    else dissent = value.dissent_line;
  }
  return {
    ok: true,
    line: value.line,
    dissent,
    citedAuthors: support.authorIds,
    pct: support.pct,
    failures,
    offendingTokens,
  };
}

export function verifyOutput(
  output: unknown,
  ctx: VerifyContext,
): {
  verification: Verification;
  selected: "line" | "alternate_line" | null;
  candidates: {
    candidate: "line" | "alternate_line";
    text: string | null;
    verification: Verification;
  }[];
} {
  const primary = verifyLine(output, ctx);
  const parsed = consensusOutputSchema.safeParse(output);
  const candidates = [
    {
      candidate: "line" as const,
      text: parsed.success ? parsed.data.line : null,
      verification: primary,
    },
  ];
  if (primary.ok) return { verification: primary, selected: "line", candidates };
  if (
    !parsed.success ||
    parsed.data.alternate_line === null ||
    primary.failures.length !== 1 ||
    primary.failures[0] !== "near_duplicate"
  )
    return { verification: primary, selected: null, candidates };
  const alternate = verifyLine(
    { ...parsed.data, line: parsed.data.alternate_line },
    {
      ...ctx,
      moderation: { ...ctx.moderation, line: ctx.moderation.alternate ?? { status: "error" } },
    },
  );
  return {
    verification: alternate,
    selected: alternate.ok ? "alternate_line" : null,
    candidates: [
      ...candidates,
      { candidate: "alternate_line", text: parsed.data.alternate_line, verification: alternate },
    ],
  };
}
