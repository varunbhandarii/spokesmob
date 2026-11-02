import { agreement } from "./agreement.js";
import type { Blocklist } from "./blocklist.js";
import { cutAtWord } from "./laugh.js";
import { fold, wordTokens } from "./normalize.js";
import type { Cluster } from "./types.js";
import { verifyTemplated } from "./verify.js";
import { formatVoiceCount } from "./voice-count.js";

export type VoteChoices = readonly [string, string];
export function titleVoteLabel(text: string): string {
  return fold(text)
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\p{L}[\p{L}\p{M}'’]*/gu, (word) => {
      const [first, ...rest] = [...word];
      return (first?.toUpperCase() ?? "") + rest.join("");
    });
}
export function ballotChoice(text: string, choices: VoteChoices): 0 | 1 | null {
  const value = fold(text).trim().replace(/\s+/gu, " ");
  if (value === "1" || value === fold(choices[0])) return 0;
  if (value === "2" || value === fold(choices[1])) return 1;
  return null;
}
export const voteMinimum = (minVoices: number, chatters: number) =>
  chatters <= 6 ? Math.max(2, minVoices) : 3;
function validateVoteLabel(raw: string, names: readonly string[], blocklist: Blocklist) {
  const display = titleVoteLabel(raw);
  if (!display) return { label: null, reason: "vote_labels_required" };
  if ([...display].length > 25) return { label: null, reason: "vote_label_length" };
  if (wordTokens(display).length > 4) return { label: null, reason: "vote_label_words" };
  if (["1", "2"].includes(display)) return { label: null, reason: "vote_label_ambiguous" };
  const check = verifyTemplated(display, {
    blocklist,
    moderation: { status: "ok", flagged: false },
  });
  if (!check.ok) return { label: null, reason: "vote_label_hygiene" };
  const tokens = wordTokens(display).map(fold);
  if (
    names.some((name) => {
      const target = wordTokens(name).map(fold);
      return (
        target.length > 0 &&
        tokens.some((_, i) => target.every((token, j) => tokens[i + j] === token))
      );
    })
  )
    return { label: null, reason: "vote_label_username" };
  return { label: display, reason: null };
}
export function validateVoteChoices(
  a: string,
  b: string,
  names: readonly string[],
  blocklist: Blocklist,
): { choices: VoteChoices | null; reason: string | null } {
  const first = validateVoteLabel(a, names, blocklist),
    second = validateVoteLabel(b, names, blocklist);
  if (!first.label || !second.label)
    return { choices: null, reason: first.reason ?? second.reason };
  if (fold(first.label) === fold(second.label))
    return { choices: null, reason: "vote_labels_same" };
  return { choices: [first.label, second.label], reason: null };
}
export function voteFailureMessage(reason: string | null): string {
  const messages: Record<string, string> = {
    vote_labels_required: "Enter two labels, or use !mob vote A | B.",
    vote_label_length: "Each label must be at most 25 characters.",
    vote_label_words: "Each label must be at most four words.",
    vote_label_ambiguous: "Labels cannot be the ballot numbers 1 or 2.",
    vote_label_hygiene: "A label contains blocked or unsafe text.",
    vote_label_username: "Labels cannot contain chatter usernames.",
    vote_labels_same: "Choose two different labels.",
    vote_moderation: "A label did not pass moderation.",
    vote_verification: "The vote prompt did not pass verification.",
    vote_unavailable: "Vote checks are unavailable; try again.",
    vote_busy: "Wait for the current line, cooldown or vote to finish.",
    vote_blocked: "Turn on the loop and check live, audio, mute, kill and spend gates.",
    vote_cancelled: "The request was cancelled by a control or safety change.",
  };
  return messages[reason ?? ""] ?? "The vote could not start.";
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
    a.authorCount < Math.max(minVoices, Math.max(2, Math.min(3, Math.ceil(0.25 * voices)))) ||
    b.authorCount < Math.max(minVoices, Math.max(2, Math.min(3, Math.ceil(0.25 * voices))))
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
    return validateVoteLabel(value, names, blocklist).label;
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
  removeMessage(id: string): boolean {
    for (const [author, ballot] of this.ballots)
      if (ballot.message === id) return this.ballots.delete(author);
    return false;
  }
  removeAuthor(id: string, cutoff = Infinity): boolean {
    const ballot = this.ballots.get(id);
    return !!ballot && ballot.at <= cutoff && this.ballots.delete(id);
  }
  counts(): [number, number] {
    const counts: [number, number] = [0, 0];
    for (const ballot of this.ballots.values()) counts[ballot.choice]++;
    return counts;
  }
  result(minVoters = 3) {
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
        n < minVoters
          ? "Not enough votes to call it."
          : counts[0] === counts[1]
            ? `It's a tie between ${this.choices[0]} and ${this.choices[1]}.`
            : `${this.choices[winner]} wins, ${pct}% of ${formatVoiceCount(n)}.`,
    };
  }
}
