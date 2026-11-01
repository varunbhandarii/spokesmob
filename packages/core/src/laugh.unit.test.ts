import { expect, test } from "vitest";
import { cutAtWord, LaughDetector } from "./laugh.js";

const text = (value: string) => [{ type: "text" as const, text: value }];
test("four distinct laugh authors trigger once per shown line with a three-minute cooldown", () => {
  const detector = new LaughDetector();
  detector.shown("one", "Chat says Gary.", 0);
  for (let i = 0; i < 3; i++)
    expect(detector.observe(`u${i}`, text("LUL"), 10, true, true)).toBeNull();
  expect(detector.observe("u0", text("lol"), 11, true, true)).toBeNull();
  expect(detector.observe("u3", text("KEKW"), 12, true, true)?.id).toBe("one");
  expect(detector.observe("u4", text("lol"), 13, true, true)).toBeNull();
  detector.shown("two", "Milo", 1000);
  for (let i = 0; i < 5; i++)
    expect(detector.observe(`u${i}`, text("LUL"), 1010, true, true)).toBeNull();
  detector.shown("three", "Gary", 180013);
  for (let i = 0; i < 3; i++) detector.observe(`u${i}`, text("LUL"), 180014, true, true);
  expect(detector.observe("u3", text("LUL"), 180014, true, true)?.id).toBe("three");
});
test("rate trigger needs three times the trailing baseline and one message per second", () => {
  const detector = new LaughDetector();
  for (let i = 0; i < 60; i++) detector.observe("u", text("hello"), i * 1000, true, true);
  detector.shown("line", "Gary", 60000);
  expect(detector.observe("u", text("hello"), 61000, true, true)).toBeNull();
  expect(detector.observe("u", text("hello"), 61000, true, true)).toBeNull();
  expect(detector.observe("u", text("hello"), 61000, true, true)?.id).toBe("line");
});
test("veto, offline, disabled and expired windows cannot trigger", () => {
  for (const reason of ["cancel", "offline", "disabled", "expired"]) {
    const detector = new LaughDetector();
    detector.shown("line", "Gary", 0);
    if (reason === "cancel") detector.cancel();
    for (let i = 0; i < 10; i++)
      expect(
        detector.observe(
          String(i),
          text("lol"),
          reason === "expired" ? 10001 : 2,
          reason !== "disabled",
          reason !== "offline",
        ),
      ).toBeNull();
  }
});
test("titles and marker descriptions stop on whole words", () => {
  expect(cutAtWord("  Gary is excellent  ", 10)).toBe("Gary is");
  expect(cutAtWord("extraordinary", 5)).toBe("");
});
