import { expect, test } from "vitest";
import { createBeatState, reduce } from "../../../../packages/core/src/beat.js";
import { createLogger } from "../log.js";
import { TwitchBus } from "./bus.js";
import type { Stream } from "./helix.js";
import { StreamStatus } from "./online.js";

const live: Stream = {
  id: "stream",
  user_id: "1",
  user_login: "demo",
  user_name: "Demo",
  game_id: "",
  game_name: "",
  type: "live",
  title: "",
  tags: [],
  viewer_count: 1,
  started_at: "2026-10-28T00:00:00Z",
  language: "en",
  thumbnail_url: "",
  tag_ids: [],
  is_mature: false,
};
const log = createLogger("silent");
test("online status stays closed until the initial query and follows stream notifications", async () => {
  const bus = new TwitchBus();
  const status = new StreamStatus({
    bus,
    channelId: "1",
    log,
    helix: { getStreams: async () => [live] },
  });
  expect(status.snapshot()).toEqual({ known: false, online: false });
  expect(await status.start()).toEqual({ known: true, online: true });
  bus.emit({ kind: "stream", online: false, at: "2026-10-28T01:00:00Z" });
  expect(status.snapshot().online).toBe(false);
  bus.emit({ kind: "stream", online: true, at: "2026-10-28T00:59:00Z" });
  expect(status.snapshot().online).toBe(false);
  bus.emit({ kind: "stream", online: true, at: "2026-10-28T01:01:00Z" });
  expect(status.snapshot().online).toBe(true);
  status.stop();
  expect(status.snapshot()).toEqual({ known: false, online: false });
});
test("a newer stream event wins over an in-flight startup query and stopped queries cannot rearm it", async () => {
  let resolve: (streams: Stream[]) => void = () => undefined;
  const bus = new TwitchBus();
  const status = new StreamStatus({
    bus,
    channelId: "1",
    log,
    helix: {
      getStreams: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
  });
  const pending = status.start();
  bus.emit({ kind: "stream", online: false, at: "2026-10-28T01:00:00Z" });
  resolve([live]);
  await pending;
  expect(status.snapshot().online).toBe(false);
  const second = status.refresh();
  status.stop();
  resolve([live]);
  await second;
  expect(status.snapshot().online).toBe(false);
});
test("offline, empty-type, mismatched and failed reads never establish online status", async () => {
  for (const data of [[], [{ ...live, type: "" as const }], [{ ...live, user_id: "2" }]]) {
    const status = new StreamStatus({
      bus: new TwitchBus(),
      channelId: "1",
      log,
      helix: { getStreams: async () => data },
    });
    expect((await status.start()).online).toBe(false);
    status.stop();
  }
  const status = new StreamStatus({
    bus: new TwitchBus(),
    channelId: "1",
    log,
    helix: {
      getStreams: async () => {
        throw new Error("Stream lookup unavailable");
      },
    },
  });
  await expect(status.start()).rejects.toThrow("unavailable");
  expect(status.snapshot().online).toBe(false);
  status.stop();
});

test("the live gate blocks the beat while offline and aborts active work on stream offline", async () => {
  const bus = new TwitchBus();
  let state = reduce(
    createBeatState({ gates: { audioConnected: true, audioActive: true, overlayConnected: true } }),
    { type: "on" },
    0,
  ).state;
  const status = new StreamStatus({
    bus,
    channelId: "1",
    log,
    helix: { getStreams: async () => [] },
  });
  let effects: string[] = [];
  status.onChange((value) => {
    const result = reduce(
      state,
      { type: "gate", changes: { online: value.known && value.online } },
      9000,
    );
    state = result.state;
    effects = result.effects.map((effect) => effect.type);
  });
  await status.start();
  expect(state.step).toBe("held");
  bus.emit({ kind: "stream", online: true, at: "2026-10-28T01:00:00Z" });
  expect(state.step).toBe("listening");
  state = reduce(
    state,
    { type: "windowReady", windowId: state.collection?.id ?? 0, voices: 2, messages: 2 },
    10000,
  ).state;
  expect(state.step).toBe("synthesizing");
  bus.emit({ kind: "stream", online: false, at: "2026-10-28T01:01:00Z" });
  expect(state.step).toBe("held");
  expect(effects).toContain("abortSynthesis");
  expect(effects).toContain("cancelVoice");
  expect(effects).not.toContain("post");
  status.stop();
});

test("a lost EventSub connection closes the live gate and ready rechecks Get Streams", async () => {
  const bus = new TwitchBus();
  let online = true;
  const status = new StreamStatus({
    bus,
    channelId: "1",
    log,
    helix: { getStreams: async () => (online ? [live] : []) },
  });
  await status.start();
  expect(status.snapshot().online).toBe(true);
  bus.health({ kind: "session", state: "backoff" });
  expect(status.snapshot()).toEqual({ known: false, online: false });
  online = false;
  bus.health({ kind: "session", state: "ready" });
  await status.refresh();
  expect(status.snapshot()).toEqual({ known: true, online: false });
  bus.health({ kind: "auth", state: "auth_required" });
  expect(status.snapshot()).toEqual({ known: false, online: false });
  status.stop();
});
