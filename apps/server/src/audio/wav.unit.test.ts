import { expect, test } from "vitest";
import { readPcmWave } from "./wav.js";

export function syntheticWave(): Buffer {
  const bytes = Buffer.alloc(60);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(52, 4);
  bytes.write("WAVE", 8);
  // Odd-sized metadata exercises RIFF padding before the format chunk.
  bytes.write("JUNK", 12);
  bytes.writeUInt32LE(1, 16);
  bytes.write("fmt ", 22);
  bytes.writeUInt32LE(16, 26);
  bytes.writeUInt16LE(1, 30);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt32LE(24000, 34);
  bytes.writeUInt32LE(48000, 38);
  bytes.writeUInt16LE(2, 42);
  bytes.writeUInt16LE(16, 44);
  bytes.write("data", 46);
  bytes.writeUInt32LE(6, 50);
  bytes.writeInt16LE(-32768, 54);
  bytes.writeInt16LE(0, 56);
  bytes.writeInt16LE(32767, 58);
  return bytes;
}

test("WAVE parsing handles chunk padding and byte offsets without rewriting samples", () => {
  const bytes = syntheticWave();
  const offset = Buffer.concat([Buffer.from([9]), bytes, Buffer.from([9])]);
  const wave = readPcmWave(offset.subarray(1, -1));
  expect(wave.sampleRate).toBe(24000);
  expect([...wave.pcm]).toEqual([...bytes.subarray(54)]);
});

test("truncated or unsupported WAVE formats are rejected", () => {
  const bytes = syntheticWave();
  expect(() => readPcmWave(bytes.subarray(0, -1))).toThrow("Truncated");
  bytes.writeUInt16LE(2, 32);
  expect(() => readPcmWave(bytes)).toThrow("mono PCM16");
  expect(() => readPcmWave(Buffer.alloc(60))).toThrow("RIFF WAVE");
});
