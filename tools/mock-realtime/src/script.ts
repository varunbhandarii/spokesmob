import { spokenWordCount } from "../../../packages/core/src/transcript.js";
import { toneBursts } from "./signals.js";

export const BEHAVIORS = [
  "normal",
  "refusal",
  "drift",
  "silent",
  "no_audio",
  "stall",
  "missing_completion",
  "incomplete",
  "disconnect",
  "late",
  "missing_usage",
] as const;
export type Behavior = (typeof BEHAVIORS)[number];
export interface ScriptFrame {
  at: number;
  event?: Record<string, unknown>;
  disconnect?: boolean;
}
export interface ScriptRequest {
  take: string;
  responseId: string;
  text: string;
  voice: string;
}
export const SYNTHETIC_USAGE = {
  input_tokens: 30,
  output_tokens: 65,
  total_tokens: 95,
  input_token_details: {
    text_tokens: 30,
    audio_tokens: 0,
    image_tokens: 0,
    cached_tokens: 0,
    cached_tokens_details: { text_tokens: 0, audio_tokens: 0, image_tokens: 0 },
  },
  output_token_details: { text_tokens: 25, audio_tokens: 40, reasoning_tokens: 10 },
};

export function responseScript(request: ScriptRequest, behavior: Behavior): ScriptFrame[] {
  const { take, responseId: id } = request;
  const base = { response_id: id, item_id: `item-${id}`, output_index: 0, content_index: 0 };
  const response = {
    id,
    metadata: { take },
    status: behavior === "incomplete" ? "incomplete" : "completed",
  };
  const text =
    behavior === "refusal"
      ? "I cannot provide that."
      : behavior === "drift"
        ? "Unexpected content entirely unrelated."
        : request.text;
  const pcm =
    behavior === "silent"
      ? new Uint8Array(96000)
      : toneBursts({
          words: spokenWordCount(request.text),
          amplitude: request.voice === "sage" ? 0.05 : 0.2,
        });
  const frames: ScriptFrame[] = [
    {
      at: 0,
      event: { type: "response.created", response: { ...response, status: "in_progress" } },
    },
  ];
  if (behavior === "no_audio") return frames;
  frames.push({
    at: 40,
    event: {
      type: "response.output_audio.delta",
      ...base,
      delta: Buffer.from(pcm.subarray(0, 24000)).toString("base64"),
    },
  });
  if (behavior === "disconnect") return [...frames, { at: 50, disconnect: true }];
  if (behavior === "stall") return frames;
  frames.push({
    at: 60,
    event: { type: "response.output_audio_transcript.delta", ...base, delta: text },
  });
  frames.push({
    at: 80,
    event: {
      type: "response.output_audio.delta",
      ...base,
      delta: Buffer.from(pcm.subarray(24000)).toString("base64"),
    },
  });
  frames.push({ at: 100, event: { type: "response.output_audio.done", ...base } });
  frames.push({
    at: 110,
    event: { type: "response.output_audio_transcript.done", ...base, transcript: text },
  });
  if (behavior !== "missing_completion")
    frames.push({
      at: behavior === "late" ? 1200 : 120,
      event: {
        type: "response.done",
        response: {
          ...response,
          ...(behavior === "missing_usage" ? {} : { usage: SYNTHETIC_USAGE }),
        },
      },
    });
  return frames;
}
