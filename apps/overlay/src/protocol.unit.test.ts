import { expect, test } from "vitest";
import { createBeatState } from "../../../packages/core/src/beat.js";
import { beatViewSchema } from "../../../packages/core/src/beat-types.js";
import { audioAllowed, decodeAudioFrame, parseControl } from "./protocol.js";

test("ordinary tabs stay silent unless the explicit audio flag is set", () => {
  expect(audioAllowed(false, "?token=synthetic")).toBe(false);
  expect(audioAllowed(true, "")).toBe(true);
  expect(audioAllowed(false, "?audio=1")).toBe(true);
  expect(audioAllowed(false, "?audio=true")).toBe(false);
});
test("the binary header uses network-order IDs and little-endian PCM", () => {
  const buffer = new ArrayBuffer(13);
  const view = new DataView(buffer);
  view.setUint8(0, 1);
  view.setUint32(1, 0x01020304, false);
  view.setUint32(5, 3, false);
  view.setInt16(9, -32768, true);
  view.setInt16(11, 16384, true);
  const frame = decodeAudioFrame(buffer);
  expect(frame).toMatchObject({ channel: "dissent", take: 0x01020304, sequence: 3 });
  expect(frame && [...frame.samples]).toEqual([-1, 0.5]);
  expect(decodeAudioFrame(new ArrayBuffer(10))).toBe(null);
  view.setUint8(0, 2);
  expect(decodeAudioFrame(buffer)).toBe(null);
});
test("control messages reject invalid IDs and durations", () => {
  expect(
    parseControl({
      type: "hello",
      role: "overlay",
      audio: false,
      state: beatViewSchema.strip().parse(createBeatState()),
    }),
  ).toMatchObject({
    type: "hello",
    audio: false,
  });
  expect(parseControl({ type: "stop", take: "all" })).toEqual({ type: "stop", take: "all" });
  expect(parseControl({ type: "prepare", take: 1, channel: "main", text: "Synthetic" })).not.toBe(
    null,
  );
  for (const value of [
    { type: "prepare", take: -1, channel: "main", text: "test" },
    { type: "play", take: 1, durationMs: Infinity },
    { type: "play", take: 1, durationMs: 30001 },
    { type: "prepare", take: 1, channel: "other", text: "test" },
  ])
    expect(parseControl(value)).toBe(null);
});
