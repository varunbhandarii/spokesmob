import { expect, test } from "vitest";
import type { BeatLine } from "./beat-types.js";
import { formatAck, formatAnnouncement, formatPost } from "./chat-output.js";

const beat: BeatLine = {
  text: "A lot of chat says blue.",
  dissent: "Some say red.",
  pct: 71,
  voices: 312,
  mood: "chill",
  question: null,
  answersQuestion: true,
  templated: false,
  citedNames: [],
  citedExemplars: [],
  raidName: null,
};
test("post wording includes computed counts and verified dissent, with meanwhile for an unrelated question", () => {
  expect(formatPost(beat)).toBe(
    'The mob says: "A lot of chat says blue." (71% of 312 voices) · dissent: "Some say red."',
  );
  expect(formatPost({ ...beat, question: "Name the cat?", answersQuestion: false })).toMatch(
    /^Meanwhile, the mob says:/,
  );
  expect(formatAnnouncement("Name the cat?")).toBe("The mob is deciding: Name the cat?");
});
test("only dissent is shortened and an oversized main line is never truncated", () => {
  const text = formatPost({ ...beat, dissent: "red ".repeat(200) });
  expect(text?.length).toBe(500);
  expect(text).toContain(beat.text);
  expect(formatPost({ ...beat, text: "a".repeat(500) })).toBe(null);
});
test("command acknowledgments do not echo gagged names or reply to veto and speak", () => {
  expect(formatAck({ action: "kill" })).toBe("Spokesmob muted");
  expect(formatAck({ action: "gag" })).toBe("Got it");
  expect(formatAck({ action: "mode", mode: "quiet" })).toBe("Spokesmob mode: quiet");
  expect(formatAck({ action: "veto" })).toBe(null);
  expect(formatAck({ action: "speak" })).toBe(null);
});
