import { expect, test } from "vitest";
import { agreement, band } from "./agreement.js";
import { clusterWindow, editDistanceAtMostOne } from "./cluster.js";
import { moodSignals } from "./mood.js";
import type { ChatMessage } from "./types.js";
import { assembleWindow } from "./window.js";

const message = (id: string, text: string, authorId = id): ChatMessage => ({
  id,
  text,
  authorId,
  authorName: `Viewer ${authorId}`,
  at: 100,
  emotes: [],
  flags: {},
  weight: 1,
});
test("author sets count a repeated chatter once and agreement unions overlapping clusters", () => {
  const input = [
    message("1", "gary", "a"),
    message("2", "gary", "a"),
    message("3", "gary", "b"),
    message("4", "pickles", "a"),
    message("5", "pickles", "c"),
  ];
  const window = assembleWindow(input, { seed: 1 });
  const clusters = clusterWindow(window);
  expect(clusters.map((cluster) => cluster.authorCount)).toEqual([2, 2]);
  expect(agreement(clusters, window.voices)).toMatchObject({
    pct: 100,
    voices: 3,
    authorIds: ["a", "b", "c"],
    display: "100% of 3 voices",
  });
  expect([band(0.5), band(0.25), band(0.24)]).toEqual(["most", "a_lot", "some"]);
});
test("seed linkage rejects chaining and the negation guard separates opposites", () => {
  const input = [
    message("1", "gary"),
    message("2", "gary"),
    message("3", "gary"),
    message("4", "name him gary"),
    message("5", "gary is a terrible name"),
    message("6", "not gary"),
  ];
  const clusters = clusterWindow(assembleWindow(input, { seed: 1 }));
  expect(clusters.map((cluster) => cluster.authorCount)).toEqual([4, 1, 1]);
  expect(clusters.find((cluster) => cluster.seedKey === "gary")?.bucketKeys).not.toContain(
    "not gary",
  );
});
test("exemplars use distinct authors, prefer clean forms and preserve stable seed keys", () => {
  const input = [
    message("1", "gary"),
    message("2", "gary"),
    message("3", "name him gary"),
    message("4", "GARY"),
  ];
  const first = clusterWindow(assembleWindow(input, { seed: 1 }));
  const reversed = clusterWindow(assembleWindow([...input].reverse(), { seed: 1 }));
  expect(first.map((cluster) => cluster.key)).toEqual(reversed.map((cluster) => cluster.key));
  expect(new Set(first[0]?.exemplars.map((exemplar) => exemplar.authorId)).size).toBe(
    first[0]?.exemplars.length,
  );
  const clean = clusterWindow(assembleWindow(input, { seed: 1 }), {
    isBlocked: (text) => text === "gary",
  });
  expect(clean[0]?.exemplars.every((exemplar) => exemplar.text !== "gary")).toBe(true);
});
test("window exclusions precede counting while emote-only authors still count toward mood", () => {
  const own = { ...message("self", "gary"), flags: { self: true } };
  const input = [
    own,
    message("cmd", "!ask gary"),
    message("gag", "gary"),
    message("deleted", "gary"),
    message("timeout", "gary"),
    { ...message("old", "gary"), at: 1 },
    message("emote", "KEKW"),
    message("clean", "gary"),
  ];
  const window = assembleWindow(input, {
    seed: 1,
    gaggedUsers: new Set(["gag"]),
    deletedIds: new Set(["deleted"]),
    clearedUsers: new Set(["timeout"]),
    clearBefore: 10,
  });
  expect(window.voices).toBe(2);
  expect(window.messages).toHaveLength(1);
  expect(moodSignals(window)).toMatchObject({ laugh_authors: 1, emote_authors: 1 });
  expect(assembleWindow([own], { seed: 1, includeSelf: true }).voices).toBe(1);
});
test("sampling is seeded without reducing the true distinct-author count", () => {
  const input = Array.from({ length: 2500 }, (_, index) =>
    message(String(index), `choice ${index}`),
  );
  const first = assembleWindow(input, { seed: 1 });
  expect(first.messages).toHaveLength(2000);
  expect(first.voices).toBe(2500);
  expect(assembleWindow(input, { seed: 1 }).messages.map((item) => item.id)).toEqual(
    first.messages.map((item) => item.id),
  );
  expect(assembleWindow(input, { seed: 2 }).messages.map((item) => item.id)).not.toEqual(
    first.messages.map((item) => item.id),
  );
});
test("fuzzy equality accepts one edit only and does not equate short names", () => {
  expect(editDistanceAtMostOne("pickles", "pickle")).toBe(true);
  expect(editDistanceAtMostOne("pickles", "pickels")).toBe(false);
  const clusters = clusterWindow(
    assembleWindow([message("1", "milo"), message("2", "mila")], { seed: 1 }),
  );
  expect(clusters).toHaveLength(2);
});
