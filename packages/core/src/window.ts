import { normalizeMessage } from "./normalize.js";
import { seededRandom } from "./random.js";
import { THRESHOLDS } from "./thresholds.js";
import type { ChatMessage, CleanedMessage, Window } from "./types.js";

export interface WindowOptions {
  seed: number;
  includeSelf?: boolean;
  gaggedUsers?: ReadonlySet<string>;
  deletedIds?: ReadonlySet<string>;
  clearedUsers?: ReadonlySet<string>;
  clearBefore?: number;
  startAt?: number;
  endAt?: number;
  excludedBucketKeys?: ReadonlySet<string>;
}

export function assembleWindow(messages: readonly ChatMessage[], options: WindowOptions): Window {
  const eligible: CleanedMessage[] = [];
  const normalized = new Map<string, CleanedMessage>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    if (
      (!options.includeSelf && message.flags.self) ||
      message.text.trimStart().startsWith("!") ||
      options.gaggedUsers?.has(message.authorId) ||
      options.deletedIds?.has(message.id) ||
      options.clearedUsers?.has(message.authorId) ||
      message.at <= (options.clearBefore ?? Number.NEGATIVE_INFINITY) ||
      message.at < (options.startAt ?? Number.NEGATIVE_INFINITY) ||
      message.at > (options.endAt ?? Number.POSITIVE_INFINITY)
    )
      continue;
    const signature = `${message.text}\0${JSON.stringify(message.fragments ?? [])}\0${message.emotes.length}`;
    const cached = normalized.get(signature);
    const item = cached
      ? {
          ...message,
          clean: cached.clean,
          key: cached.key,
          emoteCount: cached.emoteCount,
          laughTokens: cached.laughTokens,
        }
      : normalizeMessage(message);
    if (!cached) normalized.set(signature, item);
    if (!options.excludedBucketKeys?.has(item.key)) eligible.push(item);
  }
  const authorIds = [...new Set(eligible.map((message) => message.authorId))].sort();
  const candidates = eligible.filter((message) => /\p{L}/u.test(message.key));
  const random = seededRandom(options.seed);
  const sampled = candidates.length > THRESHOLDS.MAX_MESSAGES;
  let selected = candidates;
  if (sampled) {
    const reservoir = candidates
      .slice(0, THRESHOLDS.MAX_MESSAGES)
      .map((message, index) => ({ message, index }));
    for (let index = THRESHOLDS.MAX_MESSAGES; index < candidates.length; index++) {
      const slot = Math.floor(random() * (index + 1));
      const message = candidates[index];
      if (slot < reservoir.length && message) reservoir[slot] = { message, index };
    }
    selected = reservoir.sort((a, b) => a.index - b.index).map((entry) => entry.message);
  }
  return {
    messages: selected,
    moodMessages: eligible,
    voices: authorIds.length,
    authorIds,
    excluded: messages.length - eligible.length,
    sampled,
  };
}
