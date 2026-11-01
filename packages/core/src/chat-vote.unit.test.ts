import { expect, test } from "vitest";
import { createBlocklist } from "./blocklist.js";
import { ballotChoice, ChatVote, splitChoices } from "./chat-vote.js";
import type { Cluster } from "./types.js";

const cluster = (key: string, authors: string[], exemplars = [key]): Cluster => ({
  key,
  id: key,
  seedKey: key,
  bucketKeys: [key],
  buckets: [],
  authorIds: authors,
  authorCount: authors.length,
  share: authors.length / 8,
  exemplars: exemplars.map((text) => ({ text, bucketKey: key, authorId: authors[0] ?? "a" })),
  names: [],
  weight: authors.length,
});
test("close supported splits use deterministic shortest normalized labels", () => {
  const clusters = [
    cluster("gary", ["a", "b", "c", "d"], ["name him Gary", "Gary"]),
    cluster("milo", ["e", "f", "g", "h"]),
  ];
  expect(splitChoices(clusters, 8, 2, [], createBlocklist())).toEqual(["gary", "milo"]);
  expect(splitChoices(clusters, 8, 5, [], createBlocklist())).toBeNull();
  expect(splitChoices(clusters, 20, 2, [], createBlocklist())).toBeNull();
  expect(
    splitChoices(
      [clusters[0] as Cluster, cluster("milo", ["e", "f"])],
      6,
      2,
      [],
      createBlocklist(),
    ),
  ).toBeNull();
  expect(
    splitChoices(
      [cluster("gary", ["a", "b", "c", "d", "e"]), clusters[1] as Cluster],
      9,
      2,
      [],
      createBlocklist(),
    ),
  ).toBeNull();
});
test("labels reject blocked terms, usernames, URLs, mentions and long digit runs", () => {
  for (const value of [
    "@someone",
    "https://example.com",
    "123456789",
    "Viewer One",
    "forbiddenword",
  ])
    expect(
      splitChoices(
        [cluster(value, ["a", "b", "c"]), cluster("milo", ["d", "e", "f"])],
        6,
        2,
        ["Viewer One"],
        createBlocklist({ channelTerms: ["forbiddenword"] }),
      ),
    ).toBeNull();
});
test("latest eligible ballot per author wins, and deletes remove only the current ballot", () => {
  const vote = new ChatVote(["gary", "milo"]);
  vote.cast("a", "one", 0, 1);
  vote.cast("a", "two", 1, 2);
  vote.cast("a", "old", 0, 0);
  expect(vote.counts()).toEqual([0, 1]);
  vote.removeMessage("one");
  expect(vote.counts()).toEqual([0, 1]);
  vote.removeMessage("two");
  expect(vote.counts()).toEqual([0, 0]);
  vote.cast("a", "three", 0, 3);
  vote.removeAuthor("a");
  expect(vote.counts()).toEqual([0, 0]);
  expect(ballotChoice("  ＭＩＬＯ  ", vote.choices)).toBe(1);
  expect(ballotChoice("1!", vote.choices)).toBeNull();
  expect(ballotChoice("!mob 1", vote.choices)).toBeNull();
});
test("results count distinct voters, round percentages and handle ties and tiny votes", () => {
  const vote = new ChatVote(["gary", "milo"]);
  expect(vote.result().text).toBe("Not enough votes to call it.");
  vote.cast("a", "a", 0, 1);
  vote.cast("b", "b", 0, 1);
  vote.cast("c", "c", 1, 1);
  expect(vote.result()).toMatchObject({ n: 3, pct: 67, text: "gary wins, 67% of 3 voices." });
  vote.cast("d", "d", 1, 1);
  expect(vote.result().text).toBe("It's a tie between gary and milo.");
});
