import { agreement } from "./agreement.js";
import type { Blocklist } from "./blocklist.js";
import { cutAtWord } from "./laugh.js";
import { fold, wordTokens } from "./normalize.js";
import type { Cluster } from "./types.js";
import { verifyTemplated } from "./verify.js";
import { formatVoiceCount } from "./voice-count.js";

export type VoteChoices = readonly [string, string];
export function ballotChoice(text: string, choices: VoteChoices): 0 | 1 | null {
  const value = fold(text).trim().replace(/\s+/gu, " ");
  if (value === "1" || value === choices[0]) return 0;
  if (value === "2" || value === choices[1]) return 1;
  return null;
}
export function splitChoices(
  clusters: readonly Cluster[],
  voices: number,
  minVoices: number,
  names: readonly string[],
  blocklist: Blocklist,
): VoteChoices | null {
  const sorted = [...clusters].sort(
    (a, b) => b.authorCount - a.authorCount || a.key.localeCompare(b.key),
  );
  const a = sorted[0],
    b = sorted[1];
  if (
    !a ||
    !b ||
    voices < minVoices ||
    a.authorCount < Math.max(3, minVoices) ||
    b.authorCount < Math.max(3, minVoices)
  )
    return null;
  if (
    new Set([...a.authorIds, ...b.authorIds]).size / voices < 0.5 ||
    Math.abs(a.authorCount - b.authorCount) / voices > 0.1 + Number.EPSILON
  )
    return null;
  const label = (cluster: Cluster) => {
    const candidates = cluster.exemplars
      .map((item) => fold(item.text).trim().replace(/\s+/gu, " "))
      .sort((x, y) => [...x].length - [...y].length || x.localeCompare(y));
    const shortest = candidates[0];
    if (!shortest) return null;
    // Check the full exemplar before shortening so hidden unsafe suffixes cannot disappear.
    if (!verifyTemplated(shortest, { blocklist, moderation: { status: "ok", flagged: false } }).ok)
      return null;
    const value = cutAtWord(shortest.split(/\s+/u).slice(0, 4).join(" "), 25);
    if (!value || wordTokens(value).length > 4 || ["1", "2"].includes(value)) return null;
    const tokens = wordTokens(value).map(fold);
    if (
      names.some((name) => {
        const target = wordTokens(name).map(fold);
        return (
          target.length > 0 &&
          tokens.some((_, index) =>
            target.every((token, offset) => tokens[index + offset] === token),
          )
        );
      })
    )
      return null;
    return value;
  };
  const first = label(a),
    second = label(b);
  return first && second && first !== second ? [first, second] : null;
}
export class ChatVote {
  private ballots = new Map<string, { message: string; choice: 0 | 1; at: number }>();
  constructor(readonly choices: VoteChoices) {}
  cast(author: string, message: string, choice: 0 | 1, at: number) {
    const previous = this.ballots.get(author);
    if (previous && previous.at > at) return;
    this.ballots.set(author, { message, choice, at });
  }
  removeMessage(id: string) {
    for (const [author, ballot] of this.ballots)
      if (ballot.message === id) this.ballots.delete(author);
  }
  removeAuthor(id: string) {
    this.ballots.delete(id);
  }
  counts(): [number, number] {
    const counts: [number, number] = [0, 0];
    for (const ballot of this.ballots.values()) counts[ballot.choice]++;
    return counts;
  }
  result() {
    const counts = this.counts(),
      n = this.ballots.size;
    const winner = counts[0] >= counts[1] ? 0 : 1;
    const authorIds = [...this.ballots]
      .filter(([, ballot]) => ballot.choice === winner)
      .map(([author]) => author);
    const pct = agreement([{ authorIds }], n).pct;
    return {
      n,
      pct,
      counts,
      text:
        n < 3
          ? "Not enough votes to call it."
          : counts[0] === counts[1]
            ? `It's a tie between ${this.choices[0]} and ${this.choices[1]}.`
            : `${this.choices[winner]} wins, ${pct}% of ${formatVoiceCount(n)}.`,
    };
  }
}
