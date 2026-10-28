import { expect, test } from "vitest";
import { VOICE_PRICES, voiceCost } from "./cost.js";

test("voice prices and cached input are counted without double-charging reasoning", () => {
  expect(VOICE_PRICES).toEqual({
    TEXT_INPUT: 0.6,
    CACHED_TEXT_INPUT: 0.06,
    TEXT_OUTPUT: 2.4,
    AUDIO_OUTPUT: 20,
  });
  const usage = {
    textInputTokens: 100,
    cachedTextInputTokens: 50,
    textOutputTokens: 25,
    audioOutputTokens: 40,
    reasoningTokens: 10,
  };
  expect(voiceCost(usage)).toBeCloseTo(0.000893);
  expect(voiceCost({ ...usage, reasoningTokens: 0 })).toBe(voiceCost(usage));
  expect(voiceCost(null)).toBe(null);
  expect(voiceCost({ ...usage, cachedTextInputTokens: 101 })).toBe(null);
});
