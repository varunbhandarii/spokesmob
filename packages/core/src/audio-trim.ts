import { decodePcm16LE, frameMetrics } from "./audio.js";
import { VOICE_THRESHOLDS as T } from "./voice-thresholds.js";

export interface TrimMetrics {
  leadingMs: number;
  trailingMs: number;
  totalMs: number;
}
export interface TrimmedAudio {
  pcm: Uint8Array;
  trim: TrimMetrics;
  durationMs: number;
}

// The caller must verify the original PCM before calling this release-only step.
export function trimVerifiedAudio(pcm: Uint8Array): TrimmedAudio {
  const samples = decodePcm16LE(pcm);
  const frames = frameMetrics(samples, T.SAMPLE_RATE);
  const first = frames.findIndex((frame) => frame.rmsDbfs >= T.ACTIVITY_RMS_FLOOR_DBFS);
  const last = frames.findLastIndex((frame) => frame.rmsDbfs >= T.ACTIVITY_RMS_FLOOR_DBFS);
  if (first < 0 || last < 0) throw new Error("Trimming requires active audio");
  const width = (T.SAMPLE_RATE * T.FRAME_MS) / 1000;
  const start = Math.max(0, first * width - (T.SAMPLE_RATE * T.RETAIN_LEADING_MS) / 1000);
  const end = Math.min(
    samples.length,
    (last + 1) * width + (T.SAMPLE_RATE * T.RETAIN_TRAILING_MS) / 1000,
  );
  const released = Uint8Array.from(pcm.subarray(start * 2, end * 2));
  const view = new DataView(released.buffer, released.byteOffset, released.byteLength);
  const count = released.length / 2;
  const fade = Math.min(Math.round((T.SAMPLE_RATE * T.FADE_MS) / 1000), count);
  for (let index = 0; index < fade; index++) {
    const gain = fade > 1 ? index / (fade - 1) : 0;
    view.setInt16(index * 2, Math.round(view.getInt16(index * 2, true) * gain), true);
    const back = (count - 1 - index) * 2;
    view.setInt16(back, Math.round(view.getInt16(back, true) * gain), true);
  }
  const leadingMs = (start / T.SAMPLE_RATE) * 1000;
  const trailingMs = ((samples.length - end) / T.SAMPLE_RATE) * 1000;
  return {
    pcm: released,
    trim: { leadingMs, trailingMs, totalMs: leadingMs + trailingMs },
    durationMs: (count / T.SAMPLE_RATE) * 1000,
  };
}
