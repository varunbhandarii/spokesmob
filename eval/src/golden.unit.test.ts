import { expect, test } from "vitest";
import { clusterWindow } from "../../packages/core/src/cluster.js";
import { assembleWindow } from "../../packages/core/src/window.js";
import { loadGoldens, parseGolden } from "./golden.js";

test("the golden collection validates twenty unique windows and its category coverage", async () => {
  const windows = await loadGoldens();
  expect(windows.length).toBe(20);
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
  ]) {
    const golden = windows.find((window) => window.id === id);
    if (!golden) throw new Error("Missing golden");
    const window = assembleWindow(golden.messages, golden.windowOptions);
    const clusters = clusterWindow(window);
    const pct = Math.round((100 * (clusters[0]?.authorCount ?? 0)) / window.voices);
    expect(pct).toBe(golden.expect.pct_range?.[0]);
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
