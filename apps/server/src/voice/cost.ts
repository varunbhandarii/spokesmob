import type { VoiceUsage } from "./types.js";

export const VOICE_PRICES = Object.freeze({
  TEXT_INPUT: 0.6,
  CACHED_TEXT_INPUT: 0.06,
  TEXT_OUTPUT: 2.4,
  AUDIO_OUTPUT: 20,
});
export function voiceCost(usage: VoiceUsage | null): number | null {
  if (!usage) return null;
  const { textInputTokens, cachedTextInputTokens, textOutputTokens, audioOutputTokens } = usage;
  if (
    ![textInputTokens, cachedTextInputTokens, textOutputTokens, audioOutputTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    cachedTextInputTokens > textInputTokens
  )
    return null;
  // Reasoning is included in returned text output, not charged a second time.
  return (
    ((textInputTokens - cachedTextInputTokens) * VOICE_PRICES.TEXT_INPUT +
      cachedTextInputTokens * VOICE_PRICES.CACHED_TEXT_INPUT +
      textOutputTokens * VOICE_PRICES.TEXT_OUTPUT +
      audioOutputTokens * VOICE_PRICES.AUDIO_OUTPUT) /
    1_000_000
  );
}
