import { VOICE_THRESHOLDS } from "./voice-thresholds.js";

export interface AudioFrame {
  samples: number;
  rmsDbfs: number;
  peakDbfs: number;
}
export interface AudioMetrics {
  sampleRate: number;
  samples: number;
  durationMs: number;
  rmsDbfs: number;
  peakDbfs: number;
  frames: number;
  activeFrames: number;
  activeFrameRatio: number;
  activeRmsDbfs: number;
  longestZeroRunMs: number;
  leadingSilenceMs: number;
  clippingRatio: number;
}
const dbfs = (amplitude: number) =>
  amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY;

export function decodePcm16LE(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 2) throw new RangeError("PCM must contain complete 16-bit samples");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index++)
    samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

export function frameMetrics(
  samples: Float32Array,
  sampleRate: number,
  frameMs: number = VOICE_THRESHOLDS.FRAME_MS,
): AudioFrame[] {
  if (
    !Number.isSafeInteger(sampleRate) ||
    sampleRate <= 0 ||
    !Number.isFinite(frameMs) ||
    frameMs <= 0
  )
    throw new RangeError("Invalid audio frame settings");
  const width = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames: AudioFrame[] = [];
  for (let start = 0; start < samples.length; start += width) {
    let energy = 0;
    let peak = 0;
    const end = Math.min(start + width, samples.length);
    for (let index = start; index < end; index++) {
      const value = samples[index] ?? 0;
      if (!Number.isFinite(value) || Math.abs(value) > 1)
        throw new RangeError("Invalid normalized PCM sample");
      energy += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    frames.push({
      samples: end - start,
      rmsDbfs: dbfs(Math.sqrt(energy / (end - start))),
      peakDbfs: dbfs(peak),
    });
  }
  return frames;
}

export function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  activityRmsFloorDbfs: number,
): AudioMetrics {
  if (!Number.isFinite(activityRmsFloorDbfs) || activityRmsFloorDbfs >= 0)
    throw new RangeError("Activity floor must be a finite negative dBFS value");
  const frames = frameMetrics(samples, sampleRate);
  let energy = 0;
  let peak = 0;
  let zeroRun = 0;
  let longestZeroRun = 0;
  let clipped = 0;
  for (const value of samples) {
    energy += value * value;
    peak = Math.max(peak, Math.abs(value));
    zeroRun = value === 0 ? zeroRun + 1 : 0;
    longestZeroRun = Math.max(longestZeroRun, zeroRun);
    if (Math.abs(value) >= 32767 / 32768) clipped++;
  }
  let activeFrames = 0;
  let activeSamples = 0;
  let activeEnergy = 0;
  let leadingSamples = 0;
  let foundActive = false;
  for (const frame of frames) {
    if (frame.rmsDbfs >= activityRmsFloorDbfs) {
      activeFrames++;
      activeSamples += frame.samples;
      activeEnergy += (10 ** (frame.rmsDbfs / 20)) ** 2 * frame.samples;
      foundActive = true;
    } else if (!foundActive) leadingSamples += frame.samples;
  }
  return {
    sampleRate,
    samples: samples.length,
    durationMs: (samples.length / sampleRate) * 1000,
    rmsDbfs: dbfs(samples.length ? Math.sqrt(energy / samples.length) : 0),
    peakDbfs: dbfs(peak),
    frames: frames.length,
    activeFrames,
    activeFrameRatio: frames.length ? activeFrames / frames.length : 0,
    activeRmsDbfs: dbfs(activeSamples ? Math.sqrt(activeEnergy / activeSamples) : 0),
    longestZeroRunMs: (longestZeroRun / sampleRate) * 1000,
    leadingSilenceMs: (leadingSamples / sampleRate) * 1000,
    clippingRatio: samples.length ? clipped / samples.length : 0,
  };
}

export function expectedDurationMs(words: number, wordsPerSecond: number): number {
  if (
    !Number.isSafeInteger(words) ||
    words < 0 ||
    !Number.isFinite(wordsPerSecond) ||
    wordsPerSecond <= 0
  )
    throw new RangeError("Invalid speech duration settings");
  return (words / wordsPerSecond) * 1000;
}
