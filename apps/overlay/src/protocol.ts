import {
  type OverlayMessage,
  serverOverlayMessageSchema,
} from "../../../packages/core/src/overlay-protocol.js";

export type {
  AudioChannel,
  PlaybackReport,
} from "../../../packages/core/src/overlay-protocol.js";

import type { AudioChannel } from "../../../packages/core/src/overlay-protocol.js";

export type ServerControl = OverlayMessage;
export interface AudioChunk {
  channel: AudioChannel;
  take: number;
  sequence: number;
  samples: Float32Array;
}

export function audioAllowed(obs: boolean, search: string): boolean {
  return obs || new URLSearchParams(search).get("audio") === "1";
}
export function parseControl(value: unknown): ServerControl | null {
  if (!value || typeof value !== "object") return null;
  const parsed = serverOverlayMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function decodeAudioFrame(buffer: ArrayBuffer): AudioChunk | null {
  if (buffer.byteLength <= 9 || (buffer.byteLength - 9) % 2) return null;
  const view = new DataView(buffer);
  const channel = view.getUint8(0);
  if (channel > 1) return null;
  const samples = new Float32Array((buffer.byteLength - 9) / 2);
  for (let index = 0; index < samples.length; index++)
    samples[index] = view.getInt16(9 + index * 2, true) / 32768;
  return {
    channel: channel === 0 ? "main" : "dissent",
    take: view.getUint32(1, false),
    sequence: view.getUint32(5, false),
    samples,
  };
}
