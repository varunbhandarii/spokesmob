export function toneBursts(
  options: {
    words?: number;
    amplitude?: number;
    leadingMs?: number;
    trailingMs?: number;
    activeMs?: number;
  } = {},
): Uint8Array {
  const leading = options.leadingMs ?? 200;
  const trailing = options.trailingMs ?? 300;
  const active = options.activeMs ?? Math.max(1000, (options.words ?? 6) * 300);
  const length = Math.round((leading + active + trailing) * 24);
  const pcm = new Uint8Array(length * 2);
  const view = new DataView(pcm.buffer);
  for (let index = Math.round(leading * 24); index < length - Math.round(trailing * 24); index++) {
    const relative = index - Math.round(leading * 24);
    const sample =
      relative % 4800 < 3360
        ? Math.sin((2 * Math.PI * 440 * relative) / 24000) * (options.amplitude ?? 0.2)
        : 0;
    view.setInt16(index * 2, Math.round(sample * 32767), true);
  }
  return pcm;
}
