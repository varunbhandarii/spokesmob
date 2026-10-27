import { expect, test } from "vitest";
import { assembleWindow } from "../../../../packages/core/src/window.js";
import { generateScenario } from "../../../../tools/crowd-sim/src/generate.js";
import { decodeWindowSource, scenarioWindows } from "./source.js";

test("message sources require one representation and preserve emote fragments", () => {
  const window = decodeWindowSource({
    messages: [
      { author: "a", text: "Kappa", emotes: ["Kappa"] },
      { author: "b", text_b64: "R2FyeQ==" },
    ],
  });
  const assembled = assembleWindow(window.messages, window.windowOptions);
  expect(assembled.voices).toBe(2);
  expect(assembled.messages.map((message) => message.clean)).toEqual(["Gary"]);
  expect(window.encoded).toBe(true);
  expect(() =>
    decodeWindowSource({ messages: [{ author: "a", text: "a", text_b64: "YQ==" }] }),
  ).toThrow();
  expect(() => decodeWindowSource({ messages: [], crowd: {} })).toThrow();
});
test("crowd sources expand deterministically with true author quotas", () => {
  const source = {
    crowd: {
      authors: 20,
      rate: 20,
      seconds: 1,
      seed: 1,
      clusters: [
        { name: "gary", share: 0.6, phrases: ["Gary"] },
        { name: "milo", share: 0.4, phrases: ["Milo"] },
      ],
    },
  };
  const first = decodeWindowSource(source);
  expect(first).toEqual(decodeWindowSource(source));
  expect(first.messages.filter((message) => message.text === "Gary")).toHaveLength(12);
  expect(assembleWindow(first.messages, first.windowOptions).voices).toBe(20);
});
test("scenario windows preserve moderator exclusions and millisecond boundaries", () => {
  const scenario = generateScenario({ authors: 3, rate: 3, seconds: 3, emoteShare: 0 });
  scenario.lines.push({ t: 2990, kind: "chatClear" });
  const windows = scenarioWindows(scenario, 1);
  expect(windows).toHaveLength(3);
  expect(windows[0]?.messages).toHaveLength(3);
  const last = windows[2];
  expect(last && assembleWindow(last.messages, last.windowOptions).voices).toBe(0);
});
