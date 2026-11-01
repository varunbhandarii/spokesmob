export function syntheticVoiceAllowed(options: {
  stubVoice: boolean;
  headless: boolean;
  eventsubUrl: string;
  helixUrl: string;
  authUrl: string;
}): boolean {
  if (!options.stubVoice || options.headless) return false;
  return [options.eventsubUrl, options.helixUrl, options.authUrl].every((value) => {
    try {
      const url = new URL(value);
      return url.hostname === "127.0.0.1" && ["http:", "ws:"].includes(url.protocol);
    } catch {
      return false;
    }
  });
}

/** Deterministic non-speech audio; it never represents a model-generated take. */
export function demoSignal(text: string): { pcm: Uint8Array; durationMs: number } {
  const durationMs = Math.max(800, Math.min(6000, [...text].length * 60));
  const samples = Math.round(durationMs * 24);
  const pcm = new Uint8Array(samples * 2);
  const data = new DataView(pcm.buffer);
  const raw = new Float64Array(samples);
  let energy = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / 24000;
    const syllable = 0.12 + 0.88 * Math.max(0, Math.sin(2 * Math.PI * 4.5 * t)) ** 0.7;
    const angle = 2 * Math.PI * (180 * t + (20 / (2 * Math.PI)) * (1 - Math.cos(2 * Math.PI * t)));
    const fade = Math.min(1, i / 240, (samples - 1 - i) / 240);
    const value =
      (Math.sin(angle) + 0.3 * Math.sin(2 * angle) + 0.12 * Math.sin(3 * angle)) * syllable * fade;
    raw[i] = value;
    energy += value * value;
  }
  const gain = 10 ** (-18 / 20) / Math.sqrt(energy / samples);
  for (let i = 0; i < samples; i++)
    data.setInt16(i * 2, Math.round((raw[i] ?? 0) * gain * 32767), true);
  return { pcm, durationMs };
}
