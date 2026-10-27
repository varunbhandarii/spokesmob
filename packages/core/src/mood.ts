import type { MoodSignals, Window } from "./types.js";

export function moodSignals(
  window: Window,
  context: { raidActive?: boolean; hypeLevel?: number } = {},
): MoodSignals {
  return {
    laugh_authors: new Set(
      window.moodMessages
        .filter((message) => message.laughTokens.length > 0)
        .map((message) => message.authorId),
    ).size,
    emote_authors: new Set(
      window.moodMessages
        .filter((message) => message.emoteCount > 0)
        .map((message) => message.authorId),
    ).size,
    raid_active: context.raidActive ?? false,
    hype_level: context.hypeLevel ?? 0,
  };
}
