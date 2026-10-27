import { z } from "zod";
import { decodeBase64 } from "../../../../packages/core/src/base64.js";
import { fromTwitchChat } from "../../../../packages/core/src/normalize.js";
import type { ChatMessage } from "../../../../packages/core/src/types.js";
import type { WindowOptions } from "../../../../packages/core/src/window.js";
import { generateScenario } from "../../../../tools/crowd-sim/src/generate.js";
import { expandScenario, type Scenario } from "../../../../tools/mock-eventsub/src/scenario.js";
import { createLogger } from "../log.js";
import { mapNotification } from "../twitch/events.js";

export const messageSourceSchema = z
  .object({
    author: z.string().min(1),
    name: z.string().optional(),
    text: z.string().optional(),
    text_b64: z.string().optional(),
    t: z.number().nonnegative().optional(),
    emotes: z.array(z.string()).optional(),
  })
  .refine(
    (value) => (value.text !== undefined) !== (value.text_b64 !== undefined),
    "Provide one text representation",
  );
const phraseSchema = z.union([z.string().min(1), z.object({ text_b64: z.string().min(1) })]);
export const crowdSourceSchema = z.object({
  authors: z.number().int().min(1).max(2000),
  rate: z.number().positive(),
  seconds: z.number().positive(),
  seed: z.number().int(),
  clusters: z
    .array(
      z.object({
        name: z.string().min(1),
        share: z.number().positive(),
        phrases: z.array(phraseSchema).min(1),
      }),
    )
    .min(1),
  repeatShare: z.number().min(0).max(1).default(0),
  typoShare: z.number().min(0).max(1).default(0),
  caseShare: z.number().min(0).max(1).default(0),
  emoteShare: z.number().min(0).max(1).default(0),
});
export const windowSourceSchema = z
  .object({
    messages: z.array(messageSourceSchema).min(1).optional(),
    crowd: crowdSourceSchema.optional(),
  })
  .refine(
    (value) => (value.messages !== undefined) !== (value.crowd !== undefined),
    "Provide messages or a crowd",
  );
export interface InputWindow {
  messages: ChatMessage[];
  windowOptions: WindowOptions;
  encoded: boolean;
}

export function scenarioWindows(scenario: Scenario, seconds: number): InputWindow[] {
  const width = seconds * 1000;
  const windows = new Map<number, InputWindow>();
  const log = createLogger("silent");
  for (const row of expandScenario(scenario, { startAt: 0 })) {
    const index = Math.floor(row.t / width);
    const window = windows.get(index) ?? {
      messages: [],
      windowOptions: {
        seed: scenario.header.seed ?? 1,
        startAt: index * width,
        endAt: (index + 1) * width - 1,
        deletedIds: new Set<string>(),
        clearedUsers: new Set<string>(),
      },
      encoded: false,
    };
    windows.set(index, window);
    if (row.kind !== "notification") continue;
    const event = mapNotification(row.frame, "narrator", log);
    if (event?.kind === "chat") window.messages.push(fromTwitchChat(event));
    if (event?.kind === "chatDelete")
      (window.windowOptions.deletedIds as Set<string>).add(event.messageId);
    if (event?.kind === "chatClearUser")
      (window.windowOptions.clearedUsers as Set<string>).add(event.userId);
    if (event?.kind === "chatClear")
      window.windowOptions.clearBefore = Math.max(
        window.windowOptions.clearBefore ?? -1,
        Date.parse(event.at),
      );
  }
  return [...windows].sort(([a], [b]) => a - b).map(([, value]) => value);
}
export function decodeWindowSource(raw: unknown): InputWindow {
  const source = windowSourceSchema.parse(raw);
  if (source.crowd) {
    const crowd = source.crowd;
    const encoded = crowd.clusters.some((cluster) =>
      cluster.phrases.some((phrase) => typeof phrase !== "string"),
    );
    const scenario = generateScenario({
      ...crowd,
      clusters: crowd.clusters.map((cluster) => ({
        ...cluster,
        phrases: cluster.phrases.map((phrase) =>
          typeof phrase === "string" ? phrase : decodeBase64(phrase.text_b64),
        ),
      })),
    });
    const windows = scenarioWindows(scenario, crowd.seconds);
    return {
      messages: windows.flatMap((window) => window.messages),
      windowOptions: { seed: crowd.seed },
      encoded,
    };
  }
  const messages = source.messages ?? [];
  return {
    messages: messages.map((message, index) => {
      const text =
        message.text_b64 === undefined ? (message.text ?? "") : decodeBase64(message.text_b64);
      const emotes = message.emotes ?? [];
      return {
        id: `message-${index}`,
        at: message.t ?? index,
        authorId: message.author,
        authorName: message.name ?? `Viewer ${message.author}`,
        text,
        emotes,
        flags: {},
        weight: 1,
        ...(emotes.length && emotes.includes(text)
          ? { fragments: [{ type: "emote" as const, text, emoteId: "25" }] }
          : {}),
      };
    }),
    windowOptions: { seed: 1 },
    encoded: messages.some((message) => message.text_b64 !== undefined),
  };
}
