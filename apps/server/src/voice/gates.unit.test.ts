import { expect, test } from "vitest";
import { toneBursts } from "../../../../tools/mock-realtime/src/signals.js";
import { checkTranscript, checkUsableAudio, earlyPrefixCheck, verifyAndTrim } from "./gates.js";

const line = "Some of chat still says blue.";
test("synthetic speech passes both raw gates and release trimming reports removed milliseconds", () => {
  const raw = toneBursts({ words: 6, leadingMs: 300, trailingMs: 400 });
  const original = raw.slice();
  const result = verifyAndTrim({ rawPcm: raw, line, transcript: line, channel: "main" });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected synthetic audio to pass");
  expect(result.trim.leadingMs).toBeGreaterThanOrEqual(200);
  expect(result.trim.trailingMs).toBeGreaterThanOrEqual(250);
  expect(result.trim.totalMs).toBe(result.trim.leadingMs + result.trim.trailingMs);
  expect(result.audioMetrics?.durationMs).toBeGreaterThan(result.durationMs);
  expect(raw).toEqual(original);
});
test("dissent uses raw PCM before overlay gain and filtering", () => {
  const raw = toneBursts({ words: 6, amplitude: 0.035 });
  const main = verifyAndTrim({ rawPcm: raw, line, transcript: line, channel: "main" });
  const dissent = verifyAndTrim({ rawPcm: raw, line, transcript: line, channel: "dissent" });
  expect(main.ok).toBe(true);
  expect(dissent.ok).toBe(true);
  expect(dissent.audioMetrics).toEqual(main.audioMetrics);
  const mixed = Uint8Array.from(raw);
  const view = new DataView(mixed.buffer);
  for (let offset = 0; offset < mixed.length; offset += 2)
    view.setInt16(offset, Math.round(view.getInt16(offset, true) * 10 ** (-9 / 20)), true);
  expect(checkUsableAudio(mixed, line).failures).toContain("peak");
});
test("matching transcripts cannot release silent, near-silent, truncated or malformed audio", () => {
  for (const rawPcm of [
    new Uint8Array(96000),
    toneBursts({ amplitude: 10 ** (-65 / 20), words: 6 }),
  ]) {
    const result = verifyAndTrim({ rawPcm, line, transcript: line, channel: "dissent" });
    expect(result).toMatchObject({ ok: false, reason: "unusable_audio" });
    expect("pcm" in result).toBe(false);
    expect(result.failures).toContain("peak");
  }
  expect(checkUsableAudio(toneBursts().subarray(0, 9600), line).failures).toContain("duration");
  expect(checkUsableAudio(new Uint8Array(1), line).failures).toEqual(["format"]);
});
test("untrimmed leading silence and long zero runs fail before they can be hidden by trimming", () => {
  const leading = verifyAndTrim({
    rawPcm: toneBursts({ words: 6, leadingMs: 2000 }),
    line,
    transcript: line,
    channel: "main",
  });
  expect(leading).toMatchObject({ ok: false, reason: "unusable_audio" });
  expect(leading.failures).toContain("leading_silence");
  const raw = toneBursts({ words: 6, activeMs: 3200 });
  raw.fill(0, 24000, 72000);
  expect(checkUsableAudio(raw, line).failures).toContain("zero_run");
  const clipped = new Uint8Array(96000);
  const view = new DataView(clipped.buffer);
  for (let offset = 0; offset < clipped.length; offset += 2) view.setInt16(offset, 32767, true);
  expect(checkUsableAudio(clipped, line)).toMatchObject({
    ok: true,
    metrics: { clippingRatio: 1 },
  });
});
test("transcript verification preserves the fixed similarity threshold and spoken numbers", () => {
  expect(
    checkTranscript(
      "71 percent of 312 voices",
      "seventy-one percent of three hundred and twelve voices",
    ),
  ).toEqual({ ok: true, similarity: 1 });
  expect(checkTranscript(line, "An unrelated sentence about something else").ok).toBe(false);
  expect(checkTranscript("", "").ok).toBe(false);
});
test("prefix checks wait for enough text or elapsed time and compare equal-length prefixes", () => {
  expect(earlyPrefixCheck(line, "Some of", 100)).toMatchObject({ checked: false, ok: true });
  expect(earlyPrefixCheck(line, "Some of chat", 100)).toMatchObject({ checked: true, ok: true });
  expect(earlyPrefixCheck(line, "Unexpected", 1500)).toMatchObject({ checked: true, ok: false });
  expect(earlyPrefixCheck(line, "", 1600)).toMatchObject({ checked: false, ok: true });
  expect(earlyPrefixCheck(line, "I reject this", 100)).toMatchObject({ checked: true, ok: false });
});
