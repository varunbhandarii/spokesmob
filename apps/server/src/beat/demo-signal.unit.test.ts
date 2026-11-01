import { afterEach, expect, test, vi } from "vitest";
import { demoSignal, syntheticVoiceAllowed } from "./demo-signal.js";
import { FakeVoice } from "./fakes.js";

afterEach(() => vi.useRealTimers());
test("synthetic playback requires stub voice and every Twitch endpoint on the local mock", () => {
  const local = {
    stubVoice: true,
    headless: false,
    eventsubUrl: "ws://127.0.0.1:123/ws",
    helixUrl: "http://127.0.0.1:123/helix",
    authUrl: "http://127.0.0.1:123/auth",
  };
  expect(syntheticVoiceAllowed(local)).toBe(true);
  expect(syntheticVoiceAllowed({ ...local, stubVoice: false })).toBe(false);
  expect(syntheticVoiceAllowed({ ...local, headless: true })).toBe(false);
  for (const field of ["eventsubUrl", "helixUrl", "authUrl"])
    expect(syntheticVoiceAllowed({ ...local, [field]: "https://api.twitch.tv/helix" })).toBe(false);
});
test("the deterministic PCM has the requested duration, level and silent faded edges", () => {
  expect(demoSignal("x").durationMs).toBe(800);
  expect(demoSignal("x".repeat(200)).durationMs).toBe(6000);
  const result = demoSignal("Chat says Gary.");
  expect(result.durationMs).toBe(900);
  expect(result.pcm).toEqual(demoSignal("Chat says Gary.").pcm);
  const samples = new Int16Array(result.pcm.buffer);
  expect(samples.length).toBe(result.durationMs * 24);
  expect(samples[0]).toBe(0);
  expect(samples.at(-1)).toBe(0);
  const rms = Math.sqrt(
    samples.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / samples.length,
  );
  expect(20 * Math.log10(rms)).toBeCloseTo(-18, 1);
  expect(Math.max(...samples)).toBeLessThan(16000);
});
test("burst playback waits for the overlay reports instead of inventing started or ended", async () => {
  vi.useFakeTimers();
  const transport = { prepare: vi.fn(), play: vi.fn(), stop: vi.fn() };
  const voice = new FakeVoice(undefined, 1000, 0, undefined, transport);
  const reports = vi.fn();
  voice.onReport = reports;
  const take = voice.prepare("Chat says Gary.", "main");
  await vi.advanceTimersByTimeAsync(0);
  await take.play();
  expect(transport.prepare).toHaveBeenCalledWith(take.id, "main", "Chat says Gary.");
  expect(transport.play).toHaveBeenCalledWith(take.id, "main", expect.any(Uint8Array), 900);
  await vi.advanceTimersByTimeAsync(1500);
  expect(reports).not.toHaveBeenCalled();
  let settled = false;
  void take.ended.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  voice.report({ type: "ended", take: take.id });
  expect(await take.ended).toEqual({ reason: "ended" });
  const cancelled = voice.prepare("Milo", "dissent");
  cancelled.cancel("veto");
  expect(transport.stop).toHaveBeenCalledWith(cancelled.id);
});
