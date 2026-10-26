import type { ChatFragment, ChatMessage, CleanedMessage } from "./types.js";
import { LAUGH_TOKENS, NEGATIONS, STOPWORDS, THIRD_PARTY_EMOTES } from "./vocabulary.js";

const segmenter = new Intl.Segmenter("und", { granularity: "word" });
export function wordTokens(text: string): string[] {
  return [...segmenter.segment(text)].filter((item) => item.isWordLike).map((item) => item.segment);
}
export function fold(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "");
}
export function collapseLetters(text: string): string {
  return text.replace(/(\p{L})\1+/gu, "$1");
}
export function similarityTokens(clean: string): string[] {
  const normalized = fold(clean)
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ");
  return wordTokens(normalized)
    .map(collapseLetters)
    .filter((token) => NEGATIONS.has(token) || !STOPWORDS.has(token));
}
export function similarityKey(clean: string): string {
  return similarityTokens(clean).join(" ");
}

export function cleanText(fragments: readonly ChatFragment[]): {
  clean: string;
  emoteCount: number;
  laughTokens: string[];
} {
  let emoteCount = 0;
  const laughs: string[] = [];
  const text = fragments
    .map((fragment) => {
      if (fragment.type === "emote" || fragment.type === "gif") {
        emoteCount++;
        if (LAUGH_TOKENS.has(fragment.text.toLowerCase())) laughs.push(fragment.text.toLowerCase());
        return " ";
      }
      return fragment.type === "text" ? fragment.text : " ";
    })
    .join("");
  const sanitized = text
    .replace(/https?:\/\/\S+|www\.\S+|\b[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}\b/giu, " ")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|tv|gg|dev)(?:\/\S*)?/gi, " ")
    .replace(/@[\p{L}\p{N}_]+/gu, " ")
    .replace(/[😂🤣]/gu, (token) => {
      laughs.push(token);
      emoteCount++;
      return " ";
    })
    .replace(/[\p{L}\p{N}_]+/gu, (token) => {
      const lower = token.toLowerCase();
      if (LAUGH_TOKENS.has(lower)) laughs.push(lower);
      if (THIRD_PARTY_EMOTES.has(lower)) {
        emoteCount++;
        return " ";
      }
      return token;
    });
  return {
    clean: sanitized.normalize("NFKC").replace(/\s+/g, " ").trim(),
    emoteCount,
    laughTokens: laughs,
  };
}

export function normalizeMessage(message: ChatMessage): CleanedMessage {
  const cleaned = cleanText(message.fragments ?? [{ type: "text", text: message.text }]);
  return {
    ...message,
    ...cleaned,
    emoteCount: Math.max(cleaned.emoteCount, message.emotes.length),
    key: similarityKey(cleaned.clean),
  };
}

export interface TwitchChatInput {
  id: string;
  at: string;
  text: string;
  fragments: readonly ChatFragment[];
  self: boolean;
  author: {
    id: string;
    login: string;
    name: string;
    broadcaster: boolean;
    moderator: boolean;
    vip: boolean;
    subscriber: boolean;
  };
  source?: { channelId: string; login: string; messageId: string; sourceOnly: boolean };
}
export function fromTwitchChat(event: TwitchChatInput): ChatMessage {
  const at = Date.parse(event.at);
  if (!Number.isFinite(at)) throw new Error("Chat timestamp is invalid");
  return {
    id: event.id,
    at,
    authorId: event.author.id,
    authorName: event.author.name,
    authorLogin: event.author.login,
    text: event.text,
    fragments: event.fragments,
    emotes: event.fragments.flatMap((fragment) =>
      fragment.type === "emote"
        ? [fragment.emoteId]
        : fragment.type === "gif"
          ? [fragment.gifId]
          : [],
    ),
    flags: {
      self: event.self,
      broadcaster: event.author.broadcaster,
      moderator: event.author.moderator,
      vip: event.author.vip,
      subscriber: event.author.subscriber,
    },
    weight: 1,
    ...(event.source ? { source: event.source } : {}),
  };
}
