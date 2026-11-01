import { expect, test } from "vitest";
import { createBlocklist } from "./blocklist.js";
import {
  ballotChoice,
  ChatVote,
  splitChoices,
  titleVoteLabel,
  validateVoteChoices,
  voteMinimum,
} from "./chat-vote.js";
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

test("display labels are title case while matching remains folded", () => {
  expect(titleVoteLabel("captain FLUFFINGTON")).toBe("Captain Fluffington");
  expect(ballotChoice("CAPTAIN fluffington", ["Captain Fluffington", "Milo"])).toBe(0);
  expect(ballotChoice("gary", ["Gary", "Milo"])).toBe(0);
  expect(ballotChoice("MILO", ["Gary", "Milo"])).toBe(1);
});

test("four voices can form a supported two-versus-two split", () => {
  const clusters = [cluster("gary", ["a", "b"]), cluster("milo", ["c", "d"])];
  expect(splitChoices(clusters, 4, 2, [], createBlocklist())).toEqual(["Gary", "Milo"]);
  expect(splitChoices(clusters, 4, 3, [], createBlocklist())).toBeNull();
});
test("manual labels reject long, unsafe, repeated or named choices without truncation", () => {
  const blocklist = createBlocklist({ channelTerms: ["forbiddenfruit"] });
  expect(validateVoteChoices("captain fluffington", "milo", [], blocklist).choices).toEqual([
    "Captain Fluffington",
    "Milo",
  ]);
  for (const a of [
    "a".repeat(26),
    "one two three four five",
    "https://example.com",
    "@someone",
    "123456789",
    "forbiddenfruit",
    "Guest One",
  ])
    expect(validateVoteChoices(a, "Milo", ["Guest One"], blocklist).choices).toBeNull();
  expect(validateVoteChoices("MILO", "milo", [], blocklist).reason).toBe("vote_labels_same");
});
test("small-chat result minimum respects configured voices while larger rooms require three", () => {
  expect(voteMinimum(1, 6)).toBe(2);
  expect(voteMinimum(3, 6)).toBe(3);
  expect(voteMinimum(2, 7)).toBe(3);
  const vote = new ChatVote(["Gary", "Milo"]);
  vote.cast("a", "a", 0, 0);
  vote.cast("b", "b", 0, 0);
  expect(vote.result(voteMinimum(2, 4)).text).toBe("Gary wins, 100% of 2 voices.");
  expect(vote.result(voteMinimum(2, 7)).text).toBe("Not enough votes to call it.");
});
test("close supported splits use deterministic shortest normalized labels", () => {
  const clusters = [
    cluster("gary", ["a", "b", "c", "d"], ["name him Gary", "Gary"]),
    cluster("milo", ["e", "f", "g", "h"]),
  ];
  expect(splitChoices(clusters, 8, 2, [], createBlocklist())).toEqual(["Gary", "Milo"]);
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
  const vote = new ChatVote(["Gary", "Milo"]);
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
  const vote = new ChatVote(["Gary", "Milo"]);
  expect(vote.result().text).toBe("Not enough votes to call it.");
  vote.cast("a", "a", 0, 1);
  vote.cast("b", "b", 0, 1);
  vote.cast("c", "c", 1, 1);
  expect(vote.result()).toMatchObject({ n: 3, pct: 67, text: "Gary wins, 67% of 3 voices." });
  vote.cast("d", "d", 1, 1);
  expect(vote.result().text).toBe("It's a tie between Gary and Milo.");
});
