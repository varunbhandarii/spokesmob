import { expect, test } from "vitest";
import { formatVoiceCount, voiceLabel } from "./voice-count.js";

test("voice counts use singular only for one, including zero and plural totals", () => {
  expect([0, 1, 2, 312].map(formatVoiceCount)).toEqual([
    "0 voices",
    "1 voice",
    "2 voices",
    "312 voices",
  ]);
  expect(voiceLabel(1)).toBe("voice");
  expect(voiceLabel(0)).toBe("voices");
});
