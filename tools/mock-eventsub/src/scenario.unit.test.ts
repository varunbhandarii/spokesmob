import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { expandScenario, parseScenario } from "./scenario.js";

test("scenario parser reports the line number for malformed or unknown events", () => {
  const header = '{"scenario":"test","channel":{"id":"1","login":"demo"}}\n';
  expect(() => parseScenario(`${header}{"t":0,"kind":"unknown"}`)).toThrow("line 2");
  expect(() => parseScenario(`${header}{"t":0,"kind":"chat"}`)).toThrow("line 2");
  expect(() => parseScenario(`${header}{`)).toThrow("line 2");
  expect(() => parseScenario(" ")).toThrow("empty");
  const invalidFields = [
    { kind: "chat", user: "demo", name: "Demo", text: "Hi", emotes: [{ id: 25 }] },
    { kind: "chat", user: "demo", name: "Demo", text: "Hi", badges: [{}] },
    { kind: "hype", stage: "begin", level: 1.5, total: 0 },
    { kind: "hype", stage: "begin", level: 1, total: -1 },
    { kind: "control", action: "close" },
    { kind: "control", action: "close", code: 1006 },
    { kind: "control", action: "silence", ms: "1000" },
    { kind: "control", action: "revoke", type: "channel.chat.message" },
    { kind: "pollEnd", choices: [{ id: "1", title: "Gary", votes: -1 }] },
    { kind: "raw", frame: { metadata: {}, payload: {} } },
  ];
  for (const fields of invalidFields)
    expect(() => parseScenario(`${header}${JSON.stringify({ t: 0, ...fields })}`)).toThrow(
      "line 2",
    );
});

test("synthetic fixtures cover all notification kinds with stable IDs and timestamps", async () => {
  const files = [
    "name-my-cat",
    "raid-arrival",
    "hype-train",
    "reconnect-midstream",
    "keepalive-silence",
    "revocation",
    "notices",
    "poll-and-redemption",
  ];
  const summaries: unknown[] = [];
  for (const file of files) {
    const scenario = parseScenario(
      await readFile(new URL(`../scenarios/${file}.jsonl`, import.meta.url), "utf8"),
    );
    const expanded = expandScenario(scenario);
    expect(expandScenario(scenario)).toEqual(expanded);
    summaries.push({
      name: file,
      count: expanded.length,
      types: [
        ...new Set(
          expanded.map((line) =>
            line.kind === "notification" ? line.frame.metadata.subscription_type : line.action,
          ),
        ),
      ],
    });
  }
  expect(summaries).toMatchInlineSnapshot(`
    [
      {
        "count": 40,
        "name": "name-my-cat",
        "types": [
          "channel.chat.message",
        ],
      },
      {
        "count": 2,
        "name": "raid-arrival",
        "types": [
          "channel.raid",
          "channel.chat.message",
        ],
      },
      {
        "count": 4,
        "name": "hype-train",
        "types": [
          "channel.hype_train.begin",
          "channel.hype_train.progress",
          "channel.hype_train.end",
        ],
      },
      {
        "count": 4,
        "name": "reconnect-midstream",
        "types": [
          "channel.chat.message",
          "reconnect",
        ],
      },
      {
        "count": 3,
        "name": "keepalive-silence",
        "types": [
          "channel.chat.message",
          "silence",
        ],
      },
      {
        "count": 2,
        "name": "revocation",
        "types": [
          "channel.chat.message",
          "revoke",
        ],
      },
      {
        "count": 5,
        "name": "notices",
        "types": [
          "channel.chat.notification",
        ],
      },
      {
        "count": 2,
        "name": "poll-and-redemption",
        "types": [
          "channel.poll.end",
          "channel.channel_points_custom_reward_redemption.add",
        ],
      },
    ]
  `);
});

test("chat expansion preserves replies, badges, emotes and mention fragments", () => {
  const scenario = parseScenario(
    [
      { scenario: "fragments", channel: { id: "1", login: "demo" } },
      { t: 0, kind: "chat", user: "viewer01", name: "Viewer 01", text: "Hello" },
      {
        t: 1,
        kind: "chat",
        user: "viewer02",
        name: "Viewer 02",
        text: "@viewer01 Kappa",
        emotes: [{ name: "Kappa", id: "25" }],
        badges: ["subscriber"],
        replyTo: 0,
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  const result = expandScenario(scenario)[1];
  expect(expandScenario(scenario)).toMatchSnapshot();
  expect(result?.kind).toBe("notification");
  if (result?.kind !== "notification") throw new Error("Expected chat frame");
  const event = result.frame.payload.event;
  if (!event) throw new Error("Expected chat event");
  expect(event?.reply).toMatchObject({ parent_user_login: "viewer01" });
  expect(event?.badges).toEqual([{ set_id: "subscriber", id: "1", info: "6" }]);
  expect(
    (event.message as { fragments: { type: string }[] }).fragments.map((fragment) => fragment.type),
  ).toEqual(["mention", "text", "emote"]);
});
