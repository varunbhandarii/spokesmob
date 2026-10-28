import { expect, test } from "vitest";
import { normalizeSpoken, similarity, spokenWordCount } from "./transcript.js";

test("numbers and spoken number words normalize identically", () => {
  expect(
    similarity(
      "71 percent of 312 voices.",
      "Seventy-one percent of three hundred and twelve voices",
    ),
  ).toBe(1);
  expect(similarity("７１％", "seventy one percent")).toBe(1);
  expect(similarity("1000", "one thousand")).toBe(1);
  expect(normalizeSpoken("0 19 20 99 100 999")).toBe(
    "zero nineteen twenty ninety nine one hundred nine hundred ninety nine",
  );
});

test("initials, quotes and dramatic punctuation preserve spoken content", () => {
  expect(similarity("KEKW.", "K E K W.")).toBe(1);
  expect(similarity("API", "A. P. I.")).toBe(1);
  expect(similarity("‘Stop—wait—go.’", '"stop, wait, go"')).toBe(1);
  expect(normalizeSpoken("Let's try Gary.")).toBe("let s try gary");
  expect(spokenWordCount("Stop—wait—go.")).toBe(3);
});

test("similarity measures drift without weakening short or empty comparisons", () => {
  expect(similarity("Gary", "Dairy")).toBeCloseTo(0.6);
  expect(similarity("read these words", "I refuse")).toBeLessThan(0.6);
  expect(similarity("", "")).toBe(1);
  expect(similarity("hello", "")).toBe(0);
  expect(similarity("猫", "猫")).toBe(1);
  expect(spokenWordCount("  ")).toBe(0);
});
