import { afterEach, expect, test, vi } from "vitest";
import { createMockPeer } from "../../../../tools/mock-realtime/src/peer.js";
import { type Behavior, SYNTHETIC_USAGE } from "../../../../tools/mock-realtime/src/script.js";
import { createRealtimeMock } from "../../../../tools/mock-realtime/src/server.js";
import { type Clock, systemClock } from "../clock.js";
import { parseVoiceUsage, RealtimeSession, voiceInstructions } from "./session.js";
import { type RealtimeFactory, type RealtimeListeners, realtimeFactory } from "./transport.js";

const line = "Some of chat still says blue.";
const sessions: RealtimeSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  vi.useRealTimers();
});
function fixture(
  behaviors: Behavior[] = ["normal"],
  echo?: (session: Record<string, unknown>) => Record<string, unknown>,
  clock?: Clock,
) {
  const queue = [...behaviors];
  const peers: ReturnType<typeof createMockPeer>[] = [];
  const events: Record<string, unknown>[] = [];
  const callbacks: RealtimeListeners[] = [];
  const usage: { take: string; value: unknown }[] = [];
  const factory: RealtimeFactory = (listeners) => {
    callbacks.push(listeners);
    const peer = createMockPeer({
      send: listeners.event,
      disconnect: listeners.close,
      nextBehavior: () => queue.shift() ?? "normal",
      ...(echo ? { echo } : {}),
    });
    peers.push(peer);
    queueMicrotask(listeners.open);
    return {
      send: (event) => {
        events.push(event as unknown as Record<string, unknown>);
        peer.receive(event);
      },
      close: () => {
        peer.close();
        queueMicrotask(listeners.close);
      },
    };
  };
  const session = new RealtimeSession({
    voice: "sage",
    factory,
    seed: 42,
    onUsage: (take, value) => usage.push({ take, value }),
    ...(clock ? { clock } : {}),
  });
  sessions.push(session);
  return { session, peers, events, callbacks, usage };
}
test("settings are echoed and each response is out of band with the exact wrapper", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const promise = f.session.run({ take: "take-a", line });
  await vi.advanceTimersByTimeAsync(200);
  const result = await promise;
  expect(result).toMatchObject({
    reason: null,
    transcript: line,
    usage: { textInputTokens: 30, audioOutputTokens: 40 },
  });
  expect(result.pcm.byteLength).toBeGreaterThan(0);
  expect(result.ttfaMs).toBe(41);
  expect(result.completeMs).toBe(121);
  expect(f.session.health()).toMatchObject({ ok: true, lastTtfaMs: 41, lastCompleteMs: 121 });
  expect(f.events[0]).toMatchObject({
    type: "session.update",
    session: {
      type: "realtime",
      reasoning: { effort: "minimal" },
      max_output_tokens: 400,
      tracing: null,
      audio: {
        input: { turn_detection: null },
        output: { voice: "sage", format: { type: "audio/pcm", rate: 24000 } },
      },
    },
  });
  expect(f.events[1]).toMatchObject({
    type: "response.create",
    response: {
      conversation: "none",
      input: [],
      metadata: { take: "take-a" },
      instructions: voiceInstructions(line),
    },
  });
});
test.each(["voice", "format", "turn", "reasoning", "modalities", "tokens"])(
  "unaccepted %s settings fail closed",
  async (field) => {
    vi.useFakeTimers();
    const f = fixture([], (session) => {
      const copy = structuredClone(session) as {
        audio: {
          input: { turn_detection: unknown };
          output: { voice: string; format: { rate: number } };
        };
        reasoning: { effort: string };
        output_modalities: string[];
        max_output_tokens: number;
      };
      if (field === "voice") copy.audio.output.voice = "wrong";
      if (field === "format") copy.audio.output.format.rate = 48000;
      if (field === "turn") copy.audio.input.turn_detection = {};
      if (field === "reasoning") copy.reasoning.effort = "high";
      if (field === "modalities") copy.output_modalities = ["text"];
      if (field === "tokens") copy.max_output_tokens = 200;
      return copy;
    });
    const promise = f.session.run({ take: "bad-settings", line });
    await vi.advanceTimersByTimeAsync(5);
    expect(await promise).toMatchObject({ reason: "transport", pcm: new Uint8Array() });
    expect(f.events.some((event) => event.type === "response.create")).toBe(false);
  },
);
test.each([
  ["refusal", "refusal", 200],
  ["drift", "drift", 200],
  ["no_audio", "stall", 3200],
  ["stall", "stall", 2300],
  ["missing_completion", "incomplete", 2300],
  ["incomplete", "incomplete", 200],
  ["disconnect", "transport", 200],
] as const)("%s discards buffered audio and yields %s", async (behavior, reason, elapsed) => {
  vi.useFakeTimers();
  const f = fixture([behavior]);
  const promise = f.session.run({ take: behavior, line });
  await vi.advanceTimersByTimeAsync(elapsed);
  expect(await promise).toMatchObject({ reason, pcm: new Uint8Array() });
});
test("silent PCM remains raw until final usable-audio validation and missing usage stays unknown", async () => {
  vi.useFakeTimers();
  const f = fixture(["silent", "missing_usage"]);
  const first = f.session.run({ take: "silent", line });
  await vi.advanceTimersByTimeAsync(200);
  const silent = await first;
  expect(silent.reason).toBe(null);
  expect([...silent.pcm].every((value) => value === 0)).toBe(true);
  const second = f.session.run({ take: "unknown", line });
  await vi.advanceTimersByTimeAsync(200);
  expect(await second).toMatchObject({ reason: null, usage: null });
});

test("voice deadline polling keeps checking after a poll one millisecond before expiry", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const clock = { ...systemClock, now: () => Math.max(0, Date.now() - 2) };
  const f = fixture(["no_audio"], undefined, clock);
  let complete = false;
  const pending = f.session.run({ take: "early-poll", line }).then((result) => {
    complete = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(3001);
  expect(clock.now()).toBe(2999);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(25);
  expect(await pending).toMatchObject({
    reason: "stall",
    detail: "first_audio",
    pcm: new Uint8Array(),
  });
});
test("cancel ignores late PCM and stale response IDs without contaminating the next take", async () => {
  vi.useFakeTimers();
  const f = fixture(["late", "normal"]);
  const first = f.session.run({ take: "old", line });
  await vi.advanceTimersByTimeAsync(45);
  f.session.cancel();
  expect(await first).toMatchObject({ reason: "cancelled", pcm: new Uint8Array() });
  await vi.advanceTimersByTimeAsync(30);
  const next = f.session.run({ take: "next", line });
  await vi.advanceTimersByTimeAsync(5);
  f.peers[0]?.inject({
    type: "response.created",
    response: { id: "wrong", metadata: { take: "old" } },
  });
  f.peers[0]?.inject({ type: "response.output_audio.delta", response_id: "wrong", delta: "AA==" });
  await vi.advanceTimersByTimeAsync(200);
  expect(await next).toMatchObject({ reason: null, transcript: line });
  expect(f.usage.some((item) => item.take === "old")).toBe(true);
});
test("socket recovery uses bounded backoff and updates session age", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const connecting = f.session.connect();
  await vi.advanceTimersByTimeAsync(5);
  await connecting;
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.session.health().sessionAgeS).toBeGreaterThanOrEqual(2);
  f.callbacks[0]?.close();
  expect(f.session.health().ok).toBe(false);
  await vi.advanceTimersByTimeAsync(1201);
  expect(f.callbacks).toHaveLength(2);
  expect(f.session.health().ok).toBe(true);
});
test("the SDK adapter and mock URL contract never send credentials to a remote override", () => {
  expect(() => realtimeFactory("synthetic", "ws://example.com/realtime")).toThrow("loopback");
  expect(() => realtimeFactory("synthetic", "ws://user:secret@localhost/realtime")).toThrow(
    "loopback",
  );
  expect(parseVoiceUsage(SYNTHETIC_USAGE)).toMatchObject({ reasoningTokens: 10 });
  expect(parseVoiceUsage({})).toBe(null);
});
test("the real loopback WebSocket mock exercises settings, binary audio and control API", async () => {
  const mock = await createRealtimeMock();
  const session = new RealtimeSession({
    voice: "cedar",
    factory: realtimeFactory("synthetic-not-sent", mock.url),
  });
  sessions.push(session);
  try {
    const control = await fetch(`${mock.origin}/control`, {
      method: "POST",
      body: JSON.stringify({ behavior: "missing_usage" }),
    });
    expect(control.status).toBe(204);
    const result = await session.run({ take: "socket", line });
    expect(result.reason).toBe(null);
    expect(result.usage).toBe(null);
    expect(mock.requests.filter((request) => request.type === "response.create")).toHaveLength(1);
  } finally {
    session.close();
    await mock.close();
  }
});
