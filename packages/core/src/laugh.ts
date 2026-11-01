import { cleanText } from "./normalize.js";
import type { ChatFragment } from "./types.js";

export function cutAtWord(text: string, limit: number): string {
  const words = text.trim().split(/\s+/u);
  let result = "";
  for (const word of words) {
    const next = result ? `${result} ${word}` : word;
    if ([...next].length > limit) break;
    result = next;
  }
  return result;
}
export const laughAuthorThreshold = (chatters: number) =>
  Math.max(2, Math.min(4, Math.ceil(0.4 * chatters)));
export class LaughDetector {
  private history: { at: number; author: string }[] = [];
  private candidate: {
    id: string;
    text: string;
    at: number;
    baseline: number;
    authors: Set<string>;
    messageAuthors: Set<string>;
    messages: number;
  } | null = null;
  private cooldownUntil = 0;
  shown(id: string, text: string, at: number) {
    this.history = this.history.filter((time) => time.at > at - 60000 && time.at <= at);
    this.candidate = {
      id,
      text,
      at,
      baseline: this.history.length / 60,
      authors: new Set(),
      messageAuthors: new Set(),
      messages: 0,
    };
  }
  cancel() {
    this.candidate = null;
  }
  observe(
    author: string,
    fragments: readonly ChatFragment[],
    at: number,
    enabled: boolean,
    online: boolean,
    chatters?: number,
  ): { id: string; text: string } | null {
    this.history = this.history.filter((time) => time.at > at - 60000);
    this.history.push({ at, author });
    const candidate = this.candidate;
    if (!candidate || at < candidate.at || at - candidate.at > 10000) return null;
    if (!enabled || !online || at < this.cooldownUntil) return null;
    candidate.messages++;
    candidate.messageAuthors.add(author);
    if (cleanText(fragments).laughTokens.length) candidate.authors.add(author);
    return this.check(at, enabled, online, chatters);
  }
  check(
    at: number,
    enabled: boolean,
    online: boolean,
    chatters?: number,
  ): { id: string; text: string } | null {
    this.history = this.history.filter((item) => item.at > at - 60000);
    const candidate = this.candidate;
    if (
      !candidate ||
      at < candidate.at ||
      at - candidate.at > 10000 ||
      !enabled ||
      !online ||
      at < this.cooldownUntil
    )
      return null;
    const seconds = (at - candidate.at) / 1000;
    const rate = candidate.messages / Math.max(5, seconds);
    if (
      candidate.authors.size <
        laughAuthorThreshold(chatters ?? new Set(this.history.map((item) => item.author)).size) &&
      !(
        seconds >= 5 &&
        candidate.messages >= 6 &&
        candidate.messageAuthors.size >= 3 &&
        rate >= 1 &&
        rate >= 3 * candidate.baseline
      )
    )
      return null;
    this.candidate = null;
    this.cooldownUntil = at + 180000;
    return { id: candidate.id, text: candidate.text };
  }
}
