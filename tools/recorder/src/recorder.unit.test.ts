import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rmdir,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { defaultTokenFile, loadConfig } from "../../../apps/server/src/config.js";
import { anonymizeRecording } from "./anonymize.js";
import { assertLocalRecordingFile, cleanupRecordings, openRecording } from "./record.js";

const raw = JSON.stringify({
  t: 0,
  frame: {
    metadata: {
      message_id: "original-message-uuid",
      message_timestamp: "2020-01-01T00:00:00Z",
      message_type: "notification",
    },
    payload: {
      subscription: {
        id: "original-subscription",
        condition: { broadcaster_user_id: "471234567" },
        transport: { session_id: "original-session" },
      },
      event: {
        broadcaster_user_id: "471234567",
        broadcaster_user_login: "original_broadcaster",
        broadcaster_user_name: "Original Broadcaster",
        chatter_user_id: "582345678",
        chatter_user_login: "original_viewer",
        chatter_user_name: "Original Viewer",
        color: "#123456",
        message: {
          text: "original_viewer says hello",
          fragments: [
            { type: "text", text: "original_viewer says hello" },
            {
              type: "mention",
              text: "@original_broadcaster",
              mention: {
                user_id: "471234567",
                user_login: "original_broadcaster",
                user_name: "Original Broadcaster",
              },
            },
            { type: "emote", text: "Kappa", emote: { id: "emote-sample", owner_id: "693456789" } },
          ],
        },
        reply: {
          parent_message_id: "original-parent",
          parent_message_body: "private reply body",
          parent_user_id: "582345678",
          parent_user_login: "original_viewer",
          parent_user_name: "Original Viewer",
        },
        future: {
          nested: [
            { user_id: "704567890", user_login: "future_viewer", user_name: "Future Viewer" },
          ],
          extra_user_ids: ["815678901"],
        },
      },
    },
  },
});

test("anonymization removes identities everywhere, including nested values and text mentions", () => {
  const output = anonymizeRecording(raw);
  for (const original of [
    "471234567",
    "582345678",
    "693456789",
    "704567890",
    "815678901",
    "original_broadcaster",
    "Original Broadcaster",
    "original_viewer",
    "Original Viewer",
    "future_viewer",
    "Future Viewer",
    "original-session",
    "original-subscription",
    "original-message-uuid",
    "original-parent",
    "private reply body",
    "#123456",
  ])
    expect(output).not.toContain(original);
  expect(output).toBe(anonymizeRecording(raw));
  const event = JSON.parse(output).frame.payload.event;
  expect(event.chatter_user_login).toBe("viewer02");
  expect(event.message.text).toContain("viewer02 says hello");
  expect(event.message.fragments[1].mention.user_id).toBe(event.broadcaster_user_id);
  expect(event.message.fragments[2].emote).not.toHaveProperty("owner_id");
  expect(event.reply).not.toHaveProperty("parent_message_body");
});

test("synthetic prose preserves fragment categories and changes every captured chat line", () => {
  const event = JSON.parse(anonymizeRecording(raw, { replaceText: true })).frame.payload.event;
  expect(event.message.text).not.toContain("says hello");
  expect(event.message.fragments.map((fragment: { type: string }) => fragment.type)).toEqual([
    "text",
    "mention",
    "emote",
  ]);
  expect(event.message.fragments[1].text).toBe("@viewer01");
});

test("recording folders default beside the token file and accept an explicit override", () => {
  const environment = {
    TWITCH_CLIENT_ID: "demo",
    TWITCH_CLIENT_SECRET: "demo",
    TWITCH_CHANNEL: "demo",
  };
  expect(loadConfig(environment).recordingsDir).toBe(
    join(dirname(defaultTokenFile(environment)), "recordings"),
  );
  expect(loadConfig({ ...environment, RECORDINGS_DIR: "local-recordings" }).recordingsDir).toBe(
    "local-recordings",
  );
});

test("recording serializes raw frames and cleanup announces only expired JSONL files", async () => {
  const parent = join(process.cwd(), "test-results");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "recorder-"));
  const file = join(directory, "recent.jsonl");
  const old = join(directory, "expired.jsonl");
  const keep = join(directory, "keep.txt");
  try {
    const writer = await openRecording(file);
    writer.write({
      metadata: {
        message_id: "frame",
        message_type: "session_keepalive",
        message_timestamp: new Date().toISOString(),
      },
      payload: {},
    });
    expect(await writer.close()).toBe(1);
    expect(JSON.parse((await readFile(file, "utf8")).trim()).frame.metadata.message_id).toBe(
      "frame",
    );
    await writeFile(old, "{}");
    await writeFile(keep, "keep");
    const expired = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await utimes(old, expired, expired);
    await utimes(keep, expired, expired);
    let announced: string[] = [];
    expect(
      await cleanupRecordings(directory, Date.now(), (files) => {
        announced = files;
      }),
    ).toEqual([old]);
    expect(announced).toEqual([old]);
    expect((await readdir(directory)).sort()).toEqual(["keep.txt", "recent.jsonl"]);
    await expect(openRecording(file)).rejects.toThrow();
  } finally {
    for (const name of await readdir(directory)) await unlink(join(directory, name));
    await rmdir(directory);
  }
});

test("raw recording paths inside public source folders are rejected", async () => {
  await expect(
    assertLocalRecordingFile(
      new URL("../../../apps/server/src/chat-recording.jsonl", import.meta.url).pathname.replace(
        /^\/(\w:)/,
        "$1",
      ),
    ),
  ).rejects.toThrow("local ignored folder");
});
