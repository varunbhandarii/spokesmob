import { expect, test } from "vitest";
import { cleanText, similarityKey, wordTokens } from "./normalize.js";
import { THRESHOLDS } from "./thresholds.js";

test("safety and clustering thresholds remain fixed", () => {
  expect(THRESHOLDS).toEqual({
    MIN_VOICES: 2,
    SUPPORT_FRACTION: 0.05,
    DISSENT_FRACTION: 0.1,
    MAJORITY_SHARE: 0.5,
    MAX_WORDS: 20,
    MAX_DISSENT_WORDS: 12,
    MAX_DIGIT_RUN: 4,
    MAX_EXEMPLAR_CHARS: 80,
    TOP_CLUSTERS: 12,
    MAX_EXEMPLARS: 3,
    MAX_MESSAGES: 2000,
    MAX_BUCKETS: 300,
    JACCARD_MERGE: 0.5,
    NEAR_DUPLICATE: 0.8,
  });
  expect(Object.isFrozen(THRESHOLDS)).toBe(true);
});
test("similarity folds diacritics and repeated letters without dropping negation", () => {
  expect(similarityKey("GARRY gooooo café")).toBe("gary go cafe");
  expect(similarityKey("not gary")).toBe("not gary");
  expect(similarityKey("não gary")).toBe("nao gary");
  expect(similarityKey("don't pick gary")).toBe("dont pick gary");
});
test("word segmentation supports Japanese and preserves distinct word boundaries", () => {
  expect(wordTokens("猫が好き").length).toBeGreaterThan(1);
  expect(similarityKey("猫が好き")).toContain("猫");
});
test("fragment intake removes emotes, gifs, mentions and cheers while retaining mood counts", () => {
  expect(
    cleanText([
      { type: "emote", text: "LUL", emoteId: "1" },
      { type: "gif", text: "gif", gifId: "gif", url: "https://example.invalid/gif" },
      { type: "mention", text: "@viewer01", userId: "1", userLogin: "viewer01" },
      { type: "cheermote", text: "Cheer100", bits: 100 },
    ]),
  ).toEqual({ clean: "", emoteCount: 2, laughTokens: ["lul"] });
});
test("plain-text third-party emotes, URLs and mentions never become exemplars", () => {
  const result = cleanText([
    {
      type: "text",
      text: "Name him Gary KEKW @viewer01 https://example.com www.example.org example.tv user@example.com 😂",
    },
  ]);
  expect(result.clean).toBe("Name him Gary");
  expect(result.emoteCount).toBe(2);
  expect(result.laughTokens).toEqual(["😂", "kekw"]);
});
