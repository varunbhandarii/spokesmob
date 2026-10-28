export interface PcmWave {
  pcm: Uint8Array;
  sampleRate: number;
}

export function readPcmWave(bytes: Uint8Array): PcmWave {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
    throw new Error("Expected RIFF WAVE audio");
  const end = view.getUint32(4, true) + 8;
  if (end > bytes.length || end < 12) throw new Error("Truncated WAVE container");
  let sampleRate: number | undefined;
  let pcm: Uint8Array | undefined;
  for (let offset = 12; offset + 8 <= end; ) {
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > end) throw new Error("Truncated WAVE chunk");
    if (tag(offset) === "fmt ") {
      if (size < 16 || sampleRate !== undefined) throw new Error("Invalid WAVE format chunk");
      const rate = view.getUint32(body + 4, true);
      if (
        view.getUint16(body, true) !== 1 ||
        view.getUint16(body + 2, true) !== 1 ||
        view.getUint16(body + 14, true) !== 16 ||
        view.getUint16(body + 12, true) !== 2 ||
        !rate ||
        view.getUint32(body + 8, true) !== rate * 2
      )
        throw new Error("Expected mono PCM16 WAVE audio");
      sampleRate = rate;
    } else if (tag(offset) === "data") {
      if (pcm || !size || size % 2) throw new Error("Invalid WAVE sample data");
      pcm = bytes.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!sampleRate || !pcm) throw new Error("Missing WAVE format or samples");
  return { pcm, sampleRate };
}
