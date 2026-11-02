import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clusterWindow } from "../../../../packages/core/src/cluster.js";
import { assembleWindow } from "../../../../packages/core/src/window.js";
import { expandScenario, parseScenario } from "../../../../tools/mock-eventsub/src/scenario.js";
import { createLogger } from "../log.js";
import { TwitchBus } from "../twitch/bus.js";
import { mapNotification, type TwitchEvent } from "../twitch/events.js";
import { type CollectorSnapshot, ConsensusCollector } from "./collector.js";

const collectors: ConsensusCollector[] = [];
const log = createLogger("silent");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External requests are forbidden"));
});
afterEach(() => {
  for (const collector of collectors.splice(0)) collector.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(
  premoderate = vi.fn(async (_texts: readonly string[], _signal?: AbortSignal) => {}),
) {
  const bus = new TwitchBus();
  const blocklist = { check: vi.fn(() => ({ blocked: false, termIds: [] })) };
  const warn = vi.fn();
  const collector = new ConsensusCollector({
    bus,
    moderation: { premoderate },
    blocklist,
    seed: 17,
    log: { warn },
  });
  collectors.push(collector);
  const scenario = parseScenario(
    readFileSync(
      new URL("../../../../tools/mock-eventsub/scenarios/moderator-actions.jsonl", import.meta.url),
      "utf8",
    ),
  );
  const events = expandScenario(scenario, { startAt: Date.now() }).map((line) => {
    if (line.kind !== "notification") throw new Error("Expected notification");
    const event = mapNotification(line.frame, "100000001", log);
    if (!event) throw new Error("Expected mapped event");
    return event;
  });
  const first = events[0];
  if (first?.kind !== "chat") throw new Error("Expected synthetic chat");
  const chat = (id: string, text: string, at = Date.now()): TwitchEvent => ({
    ...first,
    id,
    at: new Date(at).toISOString(),
    text,
    fragments: [{ type: "text", text }],
    author: { ...first.author, id, login: id, name: id },
  });
  return { bus, collector, events, chat, premoderate, blocklist, warn };
}
function clusteredMessages(snapshot: CollectorSnapshot) {
  return clusterWindow(assembleWindow(snapshot.messages, snapshot.windowOptions)).flatMap(
    (cluster) => cluster.buckets.flatMap((bucket) => bucket.messages),
  );
}

test("twenty consecutive atomic window rolls retain every message including boundary arrivals", async () => {
  const f = fixture();
  f.collector.open();
  const expected: string[] = [];
  const observed: string[] = [];
  for (let index = 0; index < 20; index++) {
    for (const suffix of ["one", "two"]) {
      const id = `viewer-${index}-${suffix}`;
      expected.push(id);
      f.bus.emit(f.chat(id, `blue ${index}`));
    }
    await vi.advanceTimersByTimeAsync(8000);
    const closed = f.collector.roll();
    observed.push(...closed.messages.map((message) => message.id));
    expect(f.collector.snapshot().windowOptions.startAt).toBe(closed.windowOptions.endAt);
    if (index < 19) {
      const id = `boundary-${index}`;
      expected.push(id);
      f.bus.emit(f.chat(id, "boundary"));
    }
  }
  expect(observed).toEqual(expected);
  expect(new Set(observed).size).toBe(59);
});

test("moderator replay excludes deleted and cleared messages before clustering and premoderation", async () => {
  const f = fixture();
  f.collector.open();
  let previousAt = Date.now();
  for (const [index, event] of f.events.entries()) {
    const at = Date.parse(event.at);
    await vi.advanceTimersByTimeAsync(at - previousAt);
    previousAt = at;
    f.bus.emit(event);
    const current = clusteredMessages(f.collector.snapshot());
    if (index === 2)
      expect(current.map((message) => message.text)).toEqual(["Choose the orange cat"]);
    if (index === 4 || index === 6) expect(current).toEqual([]);
  }
  expect(clusteredMessages(f.collector.snapshot()).map((message) => message.text)).toEqual([
    "Choose the white cat",
  ]);
  await vi.advanceTimersByTimeAsync(1300);
  expect(f.premoderate).toHaveBeenCalledExactlyOnceWith(
    ["Choose the white cat"],
    expect.any(AbortSignal),
  );
  const final = f.collector.close();
  expect(clusteredMessages(final).map((message) => message.text)).toEqual(["Choose the white cat"]);
  expect(final.windowOptions.deletedIds?.size).toBe(4);
  expect(final.windowOptions.clearedUsers?.size).toBe(1);
  expect(f.collector.snapshot()).toEqual({
    messages: [],
    windowOptions: { seed: 17, deletedIds: new Set(), clearedUsers: new Set(), endAt: Date.now() },
  });
  f.bus.emit(f.chat("ignored", "Closed window"));
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.collector.snapshot().messages).toEqual([]);
  expect(f.premoderate).toHaveBeenCalledTimes(1);
  f.collector.open();
  f.bus.emit(f.chat("fresh", "Fresh window"));
  expect(clusteredMessages(f.collector.snapshot()).map((message) => message.id)).toEqual(["fresh"]);
});

test.each([-30000, 30000])(
  "late chat respects Twitch clear ordering with event skew %s",
  async (skew) => {
    const f = fixture();
    f.collector.open();
    const start = Date.now();
    await vi.advanceTimersByTimeAsync(1000);
    const deleted = f.events[2];
    const original = f.events[0];
    if (deleted?.kind !== "chatDelete" || original?.kind !== "chat")
      throw new Error("Expected delete");
    f.bus.emit(deleted);
    f.bus.emit(original);
    expect(clusteredMessages(f.collector.snapshot())).toEqual([]);
    f.bus.emit({
      kind: "chatClear",
      at: new Date(start + 600 + skew).toISOString(),
      channelId: "100000001",
    });
    f.bus.emit({
      kind: "chatClear",
      at: new Date(start + 200 + skew).toISOString(),
      channelId: "100000001",
    });
    f.bus.emit(f.chat("late", "Old content", start + 400 + skew));
    f.bus.emit(f.chat("fresh", "Fresh content", start + 700 + skew));
    expect(f.collector.snapshot().windowOptions.deletedIds?.has("late")).toBe(true);
    expect(clusteredMessages(f.collector.snapshot()).map((message) => message.id)).toEqual([
      "fresh",
    ]);
  },
);

test.each([-30000, 30000])(
  "live windows, premoderation and sliding use arrival time with event skew %s",
  async (skew) => {
    const f = fixture();
    f.collector.open();
    const start = Date.now();
    f.bus.emit(f.chat("first", "Choose orange", Date.now() + skew));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.premoderate).toHaveBeenCalledWith(["Choose orange"], expect.any(AbortSignal));
    f.bus.emit(f.chat("second", "Choose white", Date.now() + skew));
    expect(clusteredMessages(f.collector.snapshot())).toHaveLength(2);
    f.collector.slide(start + 1000);
    expect(clusteredMessages(f.collector.snapshot()).map((message) => message.id)).toEqual([
      "second",
    ]);
    expect(f.collector.roll().messages[0]?.at).toBe(Date.now());
    f.bus.emit(f.chat("third", "Choose gray", Date.now() + skew));
    expect(clusteredMessages(f.collector.snapshot()).map((message) => message.id)).toEqual([
      "third",
    ]);
  },
);

test("provisional moderation includes at most twelve clusters and thirty-six exemplars", async () => {
  const f = fixture();
  f.collector.open();
  const topics = [
    "apple orchard",
    "bicycle wheel",
    "candle wax",
    "dolphin ocean",
    "elephant forest",
    "falcon mountain",
    "guitar music",
    "hammer toolbox",
    "igloo snow",
    "jacket fabric",
    "kettle kitchen",
    "lantern campsite",
    "magnet metal",
    "notebook paper",
    "onion garden",
  ];
  for (const [index, topic] of topics.entries())
    for (const color of ["red", "blue", "green"])
      f.bus.emit(f.chat(`viewer${index}${color}`, `${topic} ${color}`));
  await vi.advanceTimersByTimeAsync(2000);
  const texts = f.premoderate.mock.calls[0]?.[0];
  expect(texts).toHaveLength(36);
  expect(new Set(texts)).toHaveProperty("size", 36);
  expect(f.blocklist.check).toHaveBeenCalled();
});

test("pending moderation never overlaps and receives cancellation when a window closes", async () => {
  let resolve: (() => void) | undefined;
  const pending = new Promise<void>((done) => {
    resolve = done;
  });
  const premoderate = vi.fn(async (_texts: readonly string[], _signal?: AbortSignal) => pending);
  const f = fixture(premoderate);
  f.collector.open();
  f.bus.emit(f.chat("first", "Choose orange"));
  await vi.advanceTimersByTimeAsync(2000);
  const firstSignal = premoderate.mock.calls[0]?.[1];
  expect(firstSignal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(premoderate).toHaveBeenCalledTimes(1);
  f.collector.close();
  expect(firstSignal?.aborted).toBe(true);
  f.collector.open();
  f.bus.emit(f.chat("second", "Choose white"));
  await vi.advanceTimersByTimeAsync(2000);
  expect(premoderate).toHaveBeenCalledTimes(1);
  resolve?.();
  await vi.advanceTimersByTimeAsync(2000);
  expect(premoderate).toHaveBeenCalledTimes(2);
  expect(premoderate.mock.calls[1]?.[0]).toEqual(["Choose white"]);
});

test("snapshot callers cannot mutate collector state and failures log no chat or error payload", async () => {
  const premoderate = vi.fn(async (_texts: readonly string[], _signal?: AbortSignal) => {
    throw new Error("Private provider diagnostic");
  });
  const f = fixture(premoderate);
  f.collector.open();
  f.bus.emit(f.chat("first", "Choose orange"));
  const snapshot = f.collector.snapshot();
  const message = snapshot.messages[0];
  if (!message) throw new Error("Expected chat message");
  message.text = "Changed externally";
  message.flags.self = true;
  expect(f.collector.snapshot().messages[0]).toMatchObject({
    text: "Choose orange",
    flags: { self: false },
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.warn).toHaveBeenCalledExactlyOnceWith("Provisional input moderation unavailable");
  f.collector.stop();
  f.bus.emit(f.chat("ignored", "Ignored after stop"));
  expect(f.collector.snapshot().messages).toEqual([]);
  expect(() => f.collector.open()).toThrow("stopped");
});
