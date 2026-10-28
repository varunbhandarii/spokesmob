export type AudioChannel = "main" | "dissent";
export type ServerControl =
  | { type: "hello"; audio: boolean; state: unknown }
  | { type: "prepare"; take: number; channel: AudioChannel; text: string }
  | { type: "play"; take: number; durationMs: number }
  | { type: "stop"; take: number | "all" };
export type PlaybackReport =
  | { type: "started" | "ended" | "stopped"; take: number }
  | { type: "played"; take: number; samples: number };
export interface AudioChunk {
  channel: AudioChannel;
  take: number;
  sequence: number;
  samples: Float32Array;
}

export function audioAllowed(obs: boolean, search: string): boolean {
  return obs || new URLSearchParams(search).get("audio") === "1";
}
const takeId = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff;
export function parseControl(value: unknown): ServerControl | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (message.type === "hello" && typeof message.audio === "boolean")
    return { type: "hello", audio: message.audio, state: message.state };
  if (message.type === "stop" && (message.take === "all" || takeId(message.take)))
    return { type: "stop", take: message.take };
  if (!takeId(message.take)) return null;
  if (
    message.type === "prepare" &&
    (message.channel === "main" || message.channel === "dissent") &&
    typeof message.text === "string" &&
    message.text.length <= 2000
  )
    return { type: "prepare", take: message.take, channel: message.channel, text: message.text };
  if (
    message.type === "play" &&
    typeof message.durationMs === "number" &&
    Number.isFinite(message.durationMs) &&
    message.durationMs > 0 &&
    message.durationMs <= 30000
  )
    return { type: "play", take: message.take, durationMs: message.durationMs };
  return null;
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
