import type { AudioChannel } from "../../../../packages/core/src/overlay-protocol.js";
import type { FacePose, MouthShape } from "../face/types.js";
import type { Zone } from "./layout.js";

export const LIP_SETTINGS = {
  gain: 8,
  attackMs: 30,
  releaseMs: 120,
  closeMs: 250,
  dissentScale: 0.6,
  lowBandShare: 0.6,
} as const;
const clamp = (value: number, low = 0, high = 1) =>
  Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : low;

export function mouthShape(openness: number, lowBand: number): MouthShape {
  if (openness <= 0.04) return "closed";
  if (lowBand >= LIP_SETTINGS.lowBandShare && openness > 0.1) return "o";
  if (openness < 0.25) return "mid";
  if (openness < 0.6) return "open";
  return "wide";
}

export function createLipSync() {
  let envelope = 0;
  let output = 0;
  let speaking = false;
  let closeAt: number | null = null;
  let closeFrom = 0;
  let lastLowBand = 0;
  return {
    update(input: {
      nowMs: number;
      dtMs: number;
      pose: FacePose;
      channel: AudioChannel | null;
      rms: number;
      lowBand: number;
    }) {
      const voiced = !!input.channel && (input.pose === "speaking" || input.pose === "aside");
      if (voiced) {
        const target = clamp(clamp(input.rms) * LIP_SETTINGS.gain);
        const tau = target > envelope ? LIP_SETTINGS.attackMs : LIP_SETTINGS.releaseMs;
        const mix = 1 - Math.exp(-Math.max(0, input.dtMs) / tau);
        envelope += (target - envelope) * mix;
        output = envelope * (input.channel === "dissent" ? LIP_SETTINGS.dissentScale : 1);
        lastLowBand = clamp(input.lowBand);
        speaking = true;
        closeAt = null;
      } else if (input.pose === "settle") {
        if (speaking) {
          closeAt = input.nowMs;
          closeFrom = output;
        }
        speaking = false;
        const share = closeAt === null ? 1 : clamp((input.nowMs - closeAt) / LIP_SETTINGS.closeMs);
        const ease = share * share * (3 - 2 * share);
        output = closeFrom * (1 - ease);
        envelope = output;
      } else {
        envelope = output = closeFrom = 0;
        closeAt = null;
        speaking = false;
        lastLowBand = 0;
      }
      output = clamp(output);
      return { openness: output, shape: mouthShape(output, lastLowBand) };
    },
  };
}

export function particleGaze(point: { x: number; y: number } | null, face: Zone) {
  if (!point) return { x: 0, y: 0 };
  return {
    x: clamp((point.x - face.x - face.width / 2) / (face.width / 2), -1, 1),
    y: clamp((point.y - face.y - face.height / 2) / (face.height / 2), -1, 1),
  };
}
