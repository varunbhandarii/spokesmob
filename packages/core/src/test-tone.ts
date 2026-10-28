export function testTonePcm(): Uint8Array {
  const rate = 24000;
  const pcm = new Uint8Array(rate * 2);
  const view = new DataView(pcm.buffer);
  const fade = rate / 100;
  for (let index = 0; index < rate; index++) {
    const envelope = Math.min(1, index / (fade - 1), (rate - 1 - index) / (fade - 1));
    view.setInt16(
      index * 2,
      Math.round(
        Math.sin((2 * Math.PI * 440 * index) / rate) * 10 ** (-12 / 20) * envelope * 32767,
      ),
      true,
    );
  }
  return pcm;
}
