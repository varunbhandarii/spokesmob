import { expect, test } from "vitest";
import { expandScenario, parseScenario } from "../../mock-eventsub/src/scenario.js";
import { parseArguments } from "./cli.js";
import { generateScenario, parseClusters, serializeScenario } from "./generate.js";

test("a seeded crowd is deterministic and changing the seed changes the conversation", () => {
  const first = generateScenario({ authors: 20, rate: 10, seconds: 5, seed: 7 });
  expect(generateScenario({ authors: 20, rate: 10, seconds: 5, seed: 7 })).toEqual(first);
  expect(generateScenario({ authors: 20, rate: 10, seconds: 5, seed: 8 })).not.toEqual(first);
});

test("default crowd maintains cluster shares, author count, message rate and per-author pacing", () => {
  const scenario = generateScenario();
  const lastSent = new Map<string, number>();
  const counts = { gary: 0, pickles: 0, noise: 0 };
  let emotes = 0;
  for (const line of scenario.lines) {
    if (line.kind !== "chat") throw new Error("Expected chat line");
    const previous = lastSent.get(line.user);
    if (previous !== undefined) expect(line.t - previous).toBeGreaterThanOrEqual(1000);
    lastSent.set(line.user, line.t);
    const normalized = line.text.toLowerCase().replace(/([a-z])\1+/g, "$1");
    counts[
      normalized.includes("gary") ? "gary" : normalized.includes("pickles") ? "pickles" : "noise"
    ] += 1;
    if (line.emotes?.length) emotes += 1;
  }
  expect(scenario.lines).toHaveLength(3600);
  expect(lastSent.size).toBe(300);
  expect(scenario.lines.at(-1)?.t).toBeLessThan(60000);
  expect(Math.abs(counts.gary / scenario.lines.length - 0.4)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(counts.pickles / scenario.lines.length - 0.2)).toBeLessThanOrEqual(0.05);
  expect(Math.abs(counts.noise / scenario.lines.length - 0.4)).toBeLessThanOrEqual(0.05);
  expect(emotes).toBeGreaterThan(0);
});

test("repetition and text variation are configurable", () => {
  const repeated = generateScenario({
    authors: 10,
    rate: 5,
    seconds: 10,
    repeatShare: 1,
    typoShare: 0,
    caseShare: 0,
    emoteShare: 0,
  });
  const texts = new Map<string, Set<string>>();
  for (const line of repeated.lines) {
    if (line.kind !== "chat") throw new Error("Expected chat");
    const values = texts.get(line.user) ?? new Set<string>();
    values.add(line.text);
    texts.set(line.user, values);
  }
  expect([...texts.values()].every((values) => values.size === 1)).toBe(true);
  const varied = generateScenario({
    authors: 10,
    rate: 5,
    seconds: 5,
    repeatShare: 0,
    typoShare: 1,
    caseShare: 1,
    emoteShare: 0,
  });
  expect(varied.lines.some((line) => line.kind === "chat" && /[A-Z]/.test(line.text))).toBe(true);
  const emotes = generateScenario({ authors: 10, rate: 5, seconds: 5, emoteShare: 1 });
  expect(emotes.lines.every((line) => line.kind === "chat" && line.emotes?.length === 1)).toBe(
    true,
  );
});

test("generated JSONL parses and expands through the same mock playback boundary", () => {
  const scenario = generateScenario({ authors: 12, rate: 6, seconds: 2 });
  const parsed = parseScenario(serializeScenario(scenario));
  expect(parsed).toEqual(scenario);
  const frames = expandScenario(parsed);
  expect(frames).toHaveLength(12);
  expect(
    frames.every(
      (line) =>
        line.kind === "notification" &&
        line.frame.metadata.subscription_type === "channel.chat.message",
    ),
  ).toBe(true);
});

test("CLI accepts the documented options and rejects malformed shares and impossible pacing", () => {
  expect(
    parseArguments([
      "--authors",
      "300",
      "--rate",
      "60",
      "--seconds",
      "60",
      "--clusters",
      "gary:0.4,pickles:0.2,noise:0.4",
      "--seed",
      "42",
      "--repeat-share",
      "0.2",
      "--out",
      "crowd.jsonl",
    ]),
  ).toEqual({
    options: {
      authors: 300,
      rate: 60,
      seconds: 60,
      clusters: [
        { name: "gary", share: 0.4 },
        { name: "pickles", share: 0.2 },
        { name: "noise", share: 0.4 },
      ],
      seed: 42,
      repeatShare: 0.2,
    },
    out: "crowd.jsonl",
  });
  expect(() => parseArguments(["--authors"])).toThrow("value");
  expect(() => parseArguments(["--unknown", "1"])).toThrow("Unknown");
  expect(() => parseClusters("gary:0.7,pickles:0.7")).toThrow("sum to 1");
  expect(() => parseClusters("gary:no")).toThrow("sum to 1");
  expect(() => generateScenario({ authors: 10, rate: 60 })).toThrow("one message per author");
});
