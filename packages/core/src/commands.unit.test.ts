import { expect, test } from "vitest";
import { parseCommand } from "./commands.js";

const moderator = { broadcaster: false, moderator: true };
const broadcaster = { broadcaster: true, moderator: false };
const viewer = { broadcaster: false, moderator: false };

test("only broadcasters and moderators can start a vote, preserving both labels as data", () => {
  for (const role of [broadcaster, moderator])
    expect(parseCommand("!mob vote captain fluffington | milo", [], role)).toEqual({
      action: "vote",
      a: "captain fluffington",
      b: "milo",
    });
  expect(parseCommand("!mob vote Gary | Milo", [], viewer)).toBeNull();
  expect(parseCommand("!mob vote Gary", [], broadcaster)).toEqual({ action: "vote", a: "", b: "" });
});
const cases = [
  ["!mob on", { action: "on" }],
  [" !MOB   OFF ", { action: "off" }],
  ["!mob mode AUTO", { action: "mode", mode: "auto" }],
  ["!mob mode demand", { action: "mode", mode: "demand" }],
  ["!mob mode quiet", { action: "mode", mode: "quiet" }],
  ...["speak", "veto", "unmute", "kill", "clear", "mute"].map(
    (action) => [`!mob ${action}`, { action }] as const,
  ),
  ["!mob mute 1", { action: "mute", minutes: 1 }],
  ["!mob mute 60", { action: "mute", minutes: 60 }],
  ["!ASK Name my cat", { action: "question", question: "Name my cat" }],
] as const;
test.each(cases)("authorized commands parse: %s", (text, expected) => {
  expect(parseCommand(text, [], moderator)).toEqual(expected);
  expect(parseCommand(text, [], broadcaster)).toEqual(expected);
  expect(parseCommand(text, [], viewer)).toBeNull();
});
test.each([
  "!mob",
  "!mob mode",
  "!mob mode other",
  "!mob on extra",
  "!mob mute 0",
  "!mob mute 61",
  "!mob mute 1.5",
  "!mob mute -1",
  "!mob mute 1m",
  "!ask",
  `!ask ${"x".repeat(101)}`,
  "!mob gag @typed",
  "!mob ungag @typed",
  "hello !mob kill",
  "!mob kill extra",
])("malformed commands are silent: %s", (text) =>
  expect(parseCommand(text, [], moderator)).toBeNull(),
);
test("gags resolve exactly one matching mention and never a lookalike typed name", () => {
  const fragments = [{ type: "mention", text: "@Viewer", userId: "12" }];
  expect(parseCommand("!mob gag @viewer", fragments, moderator)).toEqual({
    action: "gag",
    userId: "12",
  });
  expect(parseCommand("!mob ungag @Viewer", fragments, broadcaster)).toEqual({
    action: "ungag",
    userId: "12",
  });
  expect(parseCommand("!mob gag @Vıewer", fragments, moderator)).toBeNull();
  expect(parseCommand("!mob gag @Viewer", [...fragments, ...fragments], moderator)).toBeNull();
  expect(parseCommand("!mob gag @Viewer", fragments, viewer)).toBeNull();
});
