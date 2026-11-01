import { expect, test } from "vitest";
import { formatVoiceCount } from "../../../../packages/core/src/voice-count.js";
import { captionLingerMs, captionWords, countUp, dissentCopy, highlightedWord } from "./text.js";

test("caption words retain their source spacing and progress follows playback duration", () => {
  const line = "Chat wants Gary.";
  expect(captionWords(line).join("")).toBe(line);
  expect(highlightedWord(line, 0, 3000)).toBe(0);
  expect(highlightedWord(line, 1200, 3000)).toBe(1);
  expect(highlightedWord(line, 4000, 3000)).toBe(2);
  expect(highlightedWord(line, 100, 0)).toBe(-1);
});
test("caption linger has a readable floor and scales for longer text", () => {
  expect(captionLingerMs("Short.")).toBe(2500);
  expect(captionLingerMs("a".repeat(100))).toBe(5500);
});
test("agreement counts settle exactly and dissent keeps its own sentence", () => {
  expect(countUp(71, 0)).toBe(0);
  expect(countUp(71, 400)).toBe(71);
  expect(dissentCopy(18, "Some prefer Milo.")).toBe("18% \u00b7 Some prefer Milo.");
  expect(dissentCopy(null, "Some prefer Milo.")).toBe("");
});

test("agreement count-up uses the singular label for its displayed intermediate count", () => {
  expect(countUp(71, 12)).toBe(6);
  expect(formatVoiceCount(countUp(13, 12))).toBe("1 voice");
  expect(formatVoiceCount(countUp(13, 400))).toBe("13 voices");
});
