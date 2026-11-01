import type { BeatLine } from "./beat-types.js";
import { formatVoiceCount } from "./voice-count.js";

export function formatPost(beat: BeatLine): string | null {
  const prefix =
    beat.question && !beat.answersQuestion ? "Meanwhile, the mob says" : "The mob says";
  const base = `${prefix}: "${beat.text}" (${beat.pct}% of ${formatVoiceCount(beat.voices)})`;
  if (base.length > 500) return null;
  if (!beat.dissent) return base;
  const label = ' · dissent: "';
  const room = 500 - base.length - label.length - 1;
  if (room < 1) return base;
  const text =
    beat.dissent.length <= room ? beat.dissent : `${beat.dissent.slice(0, Math.max(0, room - 1))}…`;
  return `${base}${label}${text}"`;
}
export const formatAnnouncement = (question: string) => `The mob is deciding: ${question}`;
export function formatAck(command: { action: string; mode?: string }): string | null {
  switch (command.action) {
    case "on":
    case "off":
      return `Spokesmob ${command.action}`;
    case "mode":
      return `Spokesmob mode: ${command.mode ?? "auto"}`;
    case "mute":
    case "kill":
      return "Spokesmob muted";
    case "unmute":
      return "Spokesmob unmuted";
    case "gag":
    case "ungag":
      return "Got it";
    default:
      return null;
  }
}
