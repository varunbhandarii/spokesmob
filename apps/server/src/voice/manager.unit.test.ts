import { afterEach, expect, test, vi } from "vitest";
import { createMockPeer } from "../../../../tools/mock-realtime/src/peer.js";
import type { Behavior } from "../../../../tools/mock-realtime/src/script.js";
import { VoiceManager, type VoiceTransport } from "./manager.js";
import type { RealtimeFactory } from "./transport.js";

const line = "Some of chat still says blue.";
const managers: VoiceManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
  vi.useRealTimers();
});
function fixture(behaviors: Behavior[] = [], allowAttempt?: () => boolean) {
  const queue = [...behaviors];
  const connections: { sent: unknown[]; closed: boolean }[] = [];
  const events: { type: string; take: number | "all"; pcm?: Uint8Array; channel?: string }[] = [];
  const factory: RealtimeFactory = (listeners) => {
    const connection = { sent: [] as unknown[], closed: false };
    connections.push(connection);
    const peer = createMockPeer({
      send: listeners.event,
      disconnect: listeners.close,
      nextBehavior: () => queue.shift() ?? "normal",
    });
    queueMicrotask(listeners.open);
    return {
      send: (event) => {
        connection.sent.push(event);
        peer.receive(event);
      },
      close: () => {
        connection.closed = true;
        peer.close();
        queueMicrotask(listeners.close);
      },
    };
  };
  const transport: VoiceTransport = {
    prepare: (take, channel) => events.push({ type: "prepare", take, channel }),
    play: (take, channel, pcm) => events.push({ type: "play", take, channel, pcm }),
    stop: (take) => events.push({ type: "stop", take }),
  };
  const manager = new VoiceManager({
    mainVoice: "cedar",
    dissentVoice: "sage",
    factory,
    transport,
    ...(allowAttempt ? { allowAttempt } : {}),
  });
  managers.push(manager);
  return { manager, events, connections };
}
test("prepare verifies raw PCM, records trimming and holds all audio until play", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const take = f.manager.prepare(line);
  await vi.advanceTimersByTimeAsync(200);
  const result = await take.ready;
  expect(result.status).toBe("verified");
  expect(result.attempts).toHaveLength(1);
  expect(result.trim?.totalMs).toBeGreaterThan(0);
  expect(f.events.map((event) => event.type)).toEqual(["prepare"]);
  await take.play();
  expect(f.events.at(-1)?.type).toBe("play");
  expect(f.events.at(-1)?.pcm?.byteLength).toBe(result.durationMs * 48);
  f.manager.report({ type: "ended", take: take.id });
  expect(await take.ended).toEqual({ reason: "ended" });
});

test("startup connection warm-up configures both voices without input, responses or audio release", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const ready = f.manager.start();
  await vi.advanceTimersByTimeAsync(20);
  await ready;
  expect(f.manager.health()).toMatchObject({ main: { ok: true }, dissent: { ok: true } });
  expect(f.connections).toHaveLength(2);
  for (const connection of f.connections)
    expect(connection.sent).toEqual([
      expect.objectContaining({
        type: "session.update",
        session: expect.objectContaining({
          audio: expect.objectContaining({ input: { turn_detection: null } }),
        }),
      }),
    ]);
  expect(f.events).toEqual([]);
});
test.each([
  "refusal",
  "silent",
  "drift",
  "disconnect",
  "stall",
  "no_audio",
  "missing_completion",
  "incomplete",
] as const)("a %s failure counts once then a normal retry passes", async (behavior) => {
  vi.useFakeTimers();
  const f = fixture([behavior, "normal"]);
  const take = f.manager.prepare(line);
  await vi.advanceTimersByTimeAsync(4000);
  const result = await take.ready;
  expect(result.status).toBe("verified");
  expect(result.attempts).toHaveLength(2);
  expect(result.attempts[0]?.reason).not.toBe(null);
  expect(result.attempts[1]?.reason).toBe(null);
  expect(f.events.some((event) => event.type === "play")).toBe(false);
});
test("two failures resolve caption-only and never send PCM even if play was requested early", async () => {
  vi.useFakeTimers();
  const f = fixture(["silent", "silent"]);
  const take = f.manager.prepare(line);
  const playing = take.play();
  await vi.advanceTimersByTimeAsync(500);
  await playing;
  expect(await take.ready).toMatchObject({
    status: "caption_only",
    attempts: [{ reason: "unusable_audio" }, { reason: "unusable_audio" }],
  });
  expect(f.events.some((event) => event.type === "play")).toBe(false);
});
test("dissent is verified on raw PCM and its trimmed take result remains distinct", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const take = f.manager.prepare(line, "dissent");
  await vi.advanceTimersByTimeAsync(200);
  expect(await take.ready).toMatchObject({
    status: "verified",
    channel: "dissent",
    attempts: [{ similarity: 1 }],
  });
  await take.play();
  expect(f.events.at(-1)?.channel).toBe("dissent");
});
test("kill during generation cancels immediately and late audio never leaves the manager", async () => {
  vi.useFakeTimers();
  const f = fixture(["late"]);
  const take = f.manager.prepare(line);
  await vi.advanceTimersByTimeAsync(45);
  f.manager.cancelAll();
  expect(await take.ready).toMatchObject({ status: "cancelled" });
  await take.play();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.events.some((event) => event.type === "play")).toBe(false);
  expect(f.events.at(-1)).toMatchObject({ type: "stop", take: "all" });
});
test("kill and mute during playback send stop synchronously and block later play", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const take = f.manager.prepare(line);
  await vi.advanceTimersByTimeAsync(200);
  await take.play();
  const started = Date.now();
  f.manager.setMuted(true);
  expect(Date.now() - started).toBeLessThan(200);
  expect(f.events.at(-1)).toMatchObject({ type: "stop", take: "all" });
  expect(await take.ended).toEqual({ reason: "cancelled" });
  await take.play();
  const blocked = f.manager.prepare(line);
  expect(await blocked.ready).toMatchObject({ status: "cancelled", attempts: [] });
});
test("spend guard runs before every attempt and can prevent a retry", async () => {
  vi.useFakeTimers();
  let allowed = 0;
  const f = fixture(["silent"], () => ++allowed <= 1);
  const take = f.manager.prepare(line);
  await vi.advanceTimersByTimeAsync(300);
  expect(await take.ready).toMatchObject({ status: "caption_only" });
  expect(take.result.attempts).toHaveLength(1);
  expect(allowed).toBe(2);
});
test("a rejected spend guard avoids even opening a realtime session", async () => {
  vi.useFakeTimers();
  const f = fixture([], () => false);
  const take = f.manager.prepare(line);
  expect(await take.ready).toMatchObject({ status: "caption_only", attempts: [] });
  expect(f.connections).toHaveLength(0);
});
test("sessions rotate at fifty minutes between takes and keep both voices healthy", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const started = f.manager.start();
  await vi.advanceTimersByTimeAsync(5);
  await started;
  expect(f.connections).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(50 * 60_000 + 5);
  expect(f.connections).toHaveLength(4);
  expect(f.connections.slice(0, 2).every((connection) => connection.closed)).toBe(true);
  expect(f.manager.health().main.ok).toBe(true);
  expect(f.manager.health().main.sessionAgeS).toBeLessThan(1);
});
test("duration fallback resolves playback when reports go quiet and preserves unknown usage", async () => {
  vi.useFakeTimers();
  const f = fixture(["missing_usage"]);
  const take = f.manager.prepare(line);
  await vi.advanceTimersByTimeAsync(200);
  await take.play();
  await vi.advanceTimersByTimeAsync(5000);
  expect(await take.ended).toEqual({ reason: "duration_fallback" });
  expect(take.result.attempts[0]?.costUsd).toBe(null);
});
