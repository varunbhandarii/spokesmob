import { expect, test } from "vitest";
import { clusterWindow } from "./cluster.js";
import { seededRandom } from "./random.js";
import type { ChatMessage } from "./types.js";
import { assembleWindow } from "./window.js";

// Only the benchmark uses host APIs; production core modules keep host types unavailable.
declare const performance: { now(): number };
declare const console: { info(message: string): void };

interface Topic {
  label: string;
  share: number;
  phrases: string[];
}
const topics = (shares = [0.7, 0.2, 0.1]): Topic[] => [
  {
    label: "gary",
    share: shares[0] ?? 0.7,
    phrases: ["gary", "GARRY", "name him gary", "gary please"],
  },
  { label: "pickles", share: shares[1] ?? 0.2, phrases: ["pickles", "PICKLLES", "pickles please"] },
  { label: "milo", share: shares[2] ?? 0.1, phrases: ["milo", "MILLO", "milo please"] },
];
function labeled(input: readonly Topic[], seed: number, count = 480): ChatMessage[] {
  const random = seededRandom(seed);
  const labels = input.flatMap((topic) =>
    Array.from({ length: Math.round(topic.share * 300) }, () => topic),
  );
  return Array.from({ length: count }, (_, index) => {
    const author = index % 300;
    const topic = labels[author % labels.length];
    if (!topic) throw new Error("Expected a labeled topic");
    return {
      id: String(index),
      at: Math.floor((index / 60) * 1000),
      authorId: `viewer${author}`,
      authorName: `Viewer ${author}`,
      text: topic.phrases[Math.floor(random() * topic.phrases.length)] ?? topic.label,
      emotes: [],
      flags: {},
      weight: 1,
      label: topic.label,
    };
  });
}
test("labeled synthetic crowds meet purity, completeness and author-count targets", () => {
  const cases: Topic[][] = [
    topics(),
    topics([0.45, 0.45, 0.1]),
    topics([0.5, 0.3, 0.2]),
    topics([0.8, 0.1, 0.1]),
    topics().map((topic) => ({
      ...topic,
      phrases: topic.phrases.map((text) => text.replace(/g/g, "gg").replace(/p/g, "pp")),
    })),
    [
      { label: "gary", share: 0.45, phrases: ["gary"] },
      { label: "negative", share: 0.35, phrases: ["not gary", "not garry"] },
      { label: "pickles", share: 0.2, phrases: ["pickles"] },
    ],
    [
      { label: "spanish", share: 0.6, phrases: ["el gato", "gato"] },
      { label: "portuguese", share: 0.3, phrases: ["não gary", "nao gary"] },
      { label: "japanese", share: 0.1, phrases: ["猫が好き"] },
    ],
    Array.from({ length: 10 }, (_, index) => ({
      label: `topic${index}`,
      share: 0.1,
      phrases: [`topic${index}`],
    })),
    [
      {
        label: "copypasta",
        share: 0.8,
        phrases: ["the cat is falling asleep", "cat falling asleep"],
      },
      { label: "gary", share: 0.2, phrases: ["gary"] },
    ],
    topics([0.4, 0.3, 0.3]),
  ];
  let minPurity = 1;
  let minCompleteness = 1;
  let maxAuthorError = 0;
  cases.forEach((input, seed) => {
    const messages = labeled(input, seed);
    const clusters = clusterWindow(assembleWindow(messages, { seed }));
    expect(assembleWindow(messages, { seed }).voices).toBe(300);
    for (const cluster of clusters.slice(0, 3)) {
      const members = cluster.buckets.flatMap((bucket) => bucket.messages);
      const counts = new Map<string, number>();
      for (const message of members)
        counts.set(message.label ?? "", (counts.get(message.label ?? "") ?? 0) + 1);
      const dominant = [...counts].sort((a, b) => b[1] - a[1])[0];
      if (!dominant) throw new Error("Missing quality label");
      const expected = messages.filter((message) => message.label === dominant[0]);
      const expectedAuthors = new Set(expected.map((message) => message.authorId)).size;
      minPurity = Math.min(minPurity, dominant[1] / members.length);
      minCompleteness = Math.min(minCompleteness, dominant[1] / expected.length);
      maxAuthorError = Math.max(
        maxAuthorError,
        Math.abs(cluster.authorCount - expectedAuthors) / expectedAuthors,
      );
    }
  });
  expect(minPurity).toBeGreaterThanOrEqual(0.95);
  expect(minCompleteness).toBeGreaterThanOrEqual(0.85);
  expect(maxAuthorError).toBeLessThanOrEqual(0.1);
  const input = labeled(topics(), 10, 2000);
  const started = performance.now();
  const window = assembleWindow(input, { seed: 10 });
  const clustered = performance.now();
  clusterWindow(window);
  const finished = performance.now();
  expect(finished - clustered).toBeLessThan(200);
  console.info(
    JSON.stringify({
      check: "clustering_quality",
      windows: cases.length,
      minPurity,
      minCompleteness,
      maxAuthorError,
      cluster2000Ms: finished - clustered,
      full2000Ms: finished - started,
    }),
  );
});
