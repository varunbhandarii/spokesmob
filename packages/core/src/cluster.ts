import { stableKey } from "./random.js";
import { THRESHOLDS } from "./thresholds.js";
import type { Bucket, Cluster, Exemplar, Window } from "./types.js";
import { NEGATIONS } from "./vocabulary.js";

export function editDistanceAtMostOne(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let a = 0;
  let b = 0;
  let differences = 0;
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) {
      a++;
      b++;
      continue;
    }
    if (++differences > 1) return false;
    if (left.length >= right.length) a++;
    if (right.length >= left.length) b++;
  }
  return differences + Number(a < left.length || b < right.length) <= 1;
}
export function tokenJaccard(
  left: readonly string[],
  right: readonly string[],
  fuzzy = true,
): number {
  const a = [...new Set(left)];
  const b = [...new Set(right)];
  if (!a.length && !b.length) return 1;
  const remaining = new Set(b);
  let matches = 0;
  const unmatched: string[] = [];
  for (const token of a) {
    if (remaining.delete(token)) matches++;
    else unmatched.push(token);
  }
  if (fuzzy)
    for (const token of unmatched) {
      if (token.length < 5 || !/^\p{L}+$/u.test(token)) continue;
      const found = [...remaining].find(
        (candidate) =>
          candidate.length >= 5 &&
          /^\p{L}+$/u.test(candidate) &&
          editDistanceAtMostOne(token, candidate),
      );
      if (found) {
        matches++;
        remaining.delete(found);
      }
    }
  return matches / (a.length + b.length - matches);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function clip(text: string): string {
  if ([...text].length <= THRESHOLDS.MAX_EXEMPLAR_CHARS) return text;
  const result = [...text].slice(0, THRESHOLDS.MAX_EXEMPLAR_CHARS).join("");
  const boundary = result.lastIndexOf(" ");
  return boundary > THRESHOLDS.MAX_EXEMPLAR_CHARS / 2 ? result.slice(0, boundary) : result;
}
function exemplars(buckets: readonly Bucket[], isBlocked: (text: string) => boolean): Exemplar[] {
  const forms = new Map<string, { count: number; authors: Set<string>; bucketKey: string }>();
  for (const bucket of buckets)
    for (const message of bucket.messages) {
      const text = clip(message.clean);
      if (!text) continue;
      const form = forms.get(text) ?? {
        count: 0,
        authors: new Set<string>(),
        bucketKey: bucket.key,
      };
      form.count++;
      form.authors.add(message.authorId);
      forms.set(text, form);
    }
  let entries = [...forms].map(([text, data]) => ({ text, ...data }));
  const clean = entries.filter((entry) => !isBlocked(entry.text));
  if (clean.length) entries = clean;
  entries.sort((a, b) => b.count - a.count || compare(a.text, b.text));
  const mostCommon = entries.shift();
  if (!mostCommon) return [];
  entries.sort((a, b) => a.text.length - b.text.length || compare(a.text, b.text));
  const selected: Exemplar[] = [];
  const used = new Set<string>();
  for (const entry of [mostCommon, ...entries]) {
    const authorId = [...entry.authors].sort().find((author) => !used.has(author));
    if (!authorId) continue;
    selected.push({ text: entry.text, bucketKey: entry.bucketKey, authorId });
    used.add(authorId);
    if (selected.length === THRESHOLDS.MAX_EXEMPLARS) break;
  }
  return selected;
}

export function clusterWindow(
  window: Window,
  options: { isBlocked?: (text: string) => boolean } = {},
): Cluster[] {
  const buckets = new Map<string, Bucket>();
  for (const message of window.messages) {
    const bucket = buckets.get(message.key) ?? { key: message.key, messages: [] };
    bucket.messages.push(message);
    buckets.set(message.key, bucket);
  }
  const ordered = [...buckets.values()].sort(
    (a, b) => b.messages.length - a.messages.length || compare(a.key, b.key),
  );
  const groups: { seed: string; tokens: string[]; negative: boolean; buckets: Bucket[] }[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const bucket = ordered[index];
    if (!bucket) continue;
    const tokens = bucket.key.split(" ");
    const negative = tokens.some((token) => NEGATIONS.has(token));
    const match =
      index < THRESHOLDS.MAX_BUCKETS
        ? groups.find(
            (group) =>
              group.negative === negative &&
              tokenJaccard(tokens, group.tokens) >= THRESHOLDS.JACCARD_MERGE,
          )
        : undefined;
    if (match) match.buckets.push(bucket);
    else groups.push({ seed: bucket.key, tokens, negative, buckets: [bucket] });
  }
  const result = groups
    .map((group): Cluster => {
      const messages = group.buckets.flatMap((bucket) => bucket.messages);
      const authors = new Map<string, string>();
      for (const message of messages)
        if (!authors.has(message.authorId)) authors.set(message.authorId, message.authorName);
      const authorIds = [...authors.keys()].sort();
      return {
        key: stableKey(group.seed),
        id: "",
        seedKey: group.seed,
        bucketKeys: group.buckets.map((bucket) => bucket.key),
        buckets: group.buckets,
        authorIds,
        authorCount: authorIds.length,
        share: window.voices > 0 ? authorIds.length / window.voices : 0,
        exemplars: exemplars(group.buckets, options.isBlocked ?? (() => false)),
        names: authorIds.slice(0, 40).map((author) => authors.get(author) ?? ""),
        weight: messages.reduce((sum, message) => sum + message.weight, 0),
      };
    })
    .sort((a, b) => b.authorCount - a.authorCount || compare(a.key, b.key));
  return result.map((cluster, index) => ({ ...cluster, id: `c${index + 1}` }));
}
export const provisionalClusters = clusterWindow;
