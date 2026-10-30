import { expect, test } from "vitest";
import { clusterWindow } from "../../packages/core/src/cluster.js";
import { assembleWindow } from "../../packages/core/src/window.js";
import { loadGoldens, parseGolden } from "./golden.js";

test("the golden collection preserves the original windows and adds repeated-wording coverage", async () => {
  const windows = await loadGoldens();
  expect(windows.length).toBe(23);
  const counts = new Map<string, number>();
  for (const window of windows)
    for (const tag of window.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  expect(Object.fromEntries(counts)).toEqual({
    majority: 4,
    split: 3,
    scattered: 2,
    tiny: 2,
    emote: 1,
    multilingual: 1,
    offtopic: 1,
    canary: 4,
    toxic: 2,
    "repeat-wording": 3,
  });
  expect(
    windows.filter((window) => window.tags.includes("toxic")).every((window) => window.encoded),
  ).toBe(true);
});
test("golden expansion pins distinct-author counts rather than message totals", async () => {
  const windows = await loadGoldens();
  for (const id of [
    "name-cat-strong-majority",
    "pick-route-majority",
    "pick-tea-majority",
    "choose-hat-majority",
    "copypasta-emote-wall",
    "mixed-language-majority",
    "repeated-gary-phrasing",
    "repeated-blue-phrasing",
    "repeated-tea-phrasing",
  ]) {
    const golden = windows.find((window) => window.id === id);
    if (!golden) throw new Error("Missing golden");
    const window = assembleWindow(golden.messages, golden.windowOptions);
    const clusters = clusterWindow(window);
    const pct = Math.round((100 * (clusters[0]?.authorCount ?? 0)) / window.voices);
    expect(pct).toBe(golden.expect.pct_values?.[0] ?? golden.expect.pct_range?.[0]);
  }
});
test("malformed expectations and conflicting source representations are rejected", () => {
  const base = {
    id: "test-window",
    tags: ["tiny"],
    persona: "deadpan",
    question: null,
    messages: [{ author: "u1", text: "Gary" }],
    expect: { speak: false },
  };
  expect(parseGolden(base).messages).toHaveLength(1);
  for (const change of [
    { expect: { speak: true, pct_range: [80, 20] } },
    { messages: [{ author: "u1", text: "Gary", text_b64: "R2FyeQ==" }] },
    { id: "bad name" },
  ]) {
    expect(() => parseGolden({ ...base, ...change })).toThrow();
  }
});

test("reviewed safety labels pin canary freedom and content-based suppression reasons", async () => {
  const windows = await loadGoldens();
  for (const golden of windows.filter((window) => window.tags.includes("canary"))) {
    expect(golden.expect.speak).toBe("either");
    expect(golden.expect.safety_only).toBe(true);
    expect(golden.expect.cited_must_include_any).toBeUndefined();
    expect(golden.expect.pct_range).toBeUndefined();
    expect(golden.expect.answers_question).toBeUndefined();
  }
  for (const golden of windows.filter((window) => window.tags.includes("toxic"))) {
    expect(golden.expect.suppression_reasons).toEqual([
      "input_moderation",
      "moderation_flagged",
      "blocked_term",
    ]);
  }
  const tiny = windows.find((window) => window.id === "tiny-chat-one-voice-silent");
  expect(tiny?.expect.suppression_reasons).toEqual(["not_enough_voices"]);
});
