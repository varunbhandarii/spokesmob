import { expect, test } from "vitest";
import { sceneLine, sceneState } from "./scenes.js";
import { createViewStore } from "./store.js";

function fixture() {
  const store = createViewStore();
  store.receive({
    type: "hello",
    role: "overlay",
    audio: true,
    channel: "synthetic_channel",
    state: sceneState,
  });
  store.receive({ type: "state", ...sceneState, step: "preview" });
  store.receive(sceneLine);
  store.receive({ type: "prepare", take: 1, channel: "main", text: sceneLine.text });
  return store;
}
test("preview and play metadata never publish caption text; main started does", () => {
  const store = fixture();
  expect(store.view().pose).toBe("inhale");
  expect(store.view().caption).toBeNull();
  store.receive({ type: "play", take: 1, durationMs: 2000 });
  expect(store.view().caption).toBeNull();
  store.playback({ type: "started", take: 1 });
  expect(store.view()).toMatchObject({
    pose: "speaking",
    caption: { line: { text: sceneLine.text } },
  });
  store.sample(0.123);
  expect(store.view().rms).toBe(0.123);
  store.playback({ type: "ended", take: 1 });
  expect(store.view()).toMatchObject({ pose: "settle", rms: 0 });
});
test("a reveal publishes captions only for the matching active take", () => {
  const store = fixture();
  store.receive({ type: "reveal", take: 99 });
  expect(store.view().caption).toBeNull();
  store.receive({ type: "reveal", take: 1 });
  expect(store.view()).toMatchObject({ pose: "reading", caption: { source: "reveal" } });
});
test("a new preview clears a lingering old line even before its new line metadata arrives", () => {
  const store = fixture();
  store.playback({ type: "started", take: 1 });
  store.playback({ type: "ended", take: 1 });
  store.receive({ type: "state", ...sceneState, step: "preview" });
  expect(store.view()).toMatchObject({ pose: "inhale", caption: null, rms: 0 });
});
test("stop all blocks existing IDs but permits a fresh caption, which is itself vetoable", () => {
  const store = fixture();
  store.receive({ type: "stop", take: "all" });
  store.receive(sceneLine);
  store.receive({ type: "reveal", take: 1 });
  expect(store.view().caption).toBeNull();
  store.receive({ ...sceneLine, take: 2 });
  store.receive({ type: "reveal", take: 2 });
  expect(store.view().caption?.line.take).toBe(2);
  store.receive({ type: "stop", take: 1 });
  expect(store.view()).toMatchObject({ pose: "reading", caption: { line: { take: 2 } } });
  store.receive({ type: "veto", take: 2 });
  store.receive({ type: "reveal", take: 2 });
  expect(store.view().caption).toBeNull();
  store.receive({ type: "state", ...sceneState, step: "cooldown" });
  expect(store.view().pose).toBe("idle");
});
test("mute and kill clear a fallback and unmute cannot revive its stopped ID", () => {
  for (const reason of ["muted", "killed"] as const) {
    const store = fixture();
    store.receive({ type: "stop", take: "all" });
    store.receive({ ...sceneLine, take: 2 });
    store.receive({ type: "reveal", take: 2 });
    store.receive({ type: "state", ...sceneState, step: "held", muted: true, heldBy: [reason] });
    expect(store.view()).toMatchObject({ pose: "muted", caption: null });
    store.receive({ type: "state", ...sceneState });
    store.receive({ ...sceneLine, take: 2 });
    store.receive({ type: "reveal", take: 2 });
    expect(store.view().caption).toBeNull();
  }
});
test.each(["stop", "veto"] as const)(
  "%s clears text and prevents every late reveal or start",
  (type) => {
    const store = fixture();
    store.playback({ type: "started", take: 1 });
    store.receive({ type, take: 1 });
    store.receive(sceneLine);
    store.receive({ type: "prepare", take: 1, channel: "main", text: sceneLine.text });
    store.receive({ type: "reveal", take: 1 });
    store.playback({ type: "started", take: 1 });
    expect(store.view()).toMatchObject({ pose: "idle", caption: null, rms: 0 });
  },
);
test("dissent starts its aside pose and caption only on its own started report", () => {
  const store = fixture();
  store.playback({ type: "started", take: 1 });
  store.receive({ type: "prepare", take: 2, channel: "dissent", text: sceneLine.dissent });
  expect(store.view().caption?.dissent).toBe(false);
  store.playback({ type: "ended", take: 1 });
  store.playback({ type: "started", take: 2 });
  expect(store.view()).toMatchObject({
    pose: "aside",
    audioChannel: "dissent",
    caption: { dissent: true, line: { dissentPct: 18 } },
  });
});
test("mute, kill, offline, cap, missing audio and inactive source clear the view", () => {
  for (const heldBy of [
    ["muted"],
    ["killed"],
    ["offline"],
    ["capped"],
    ["no_audio_client"],
    ["overlay_inactive"],
  ] as const) {
    const store = fixture();
    store.playback({ type: "started", take: 1 });
    store.receive({ type: "state", ...sceneState, step: "held", heldBy: [...heldBy] });
    expect(store.view().caption).toBeNull();
    expect(store.view().pose).toBe(
      heldBy[0] === "muted" || heldBy[0] === "killed" ? "muted" : "asleep",
    );
  }
  const store = fixture();
  store.setActive(false);
  expect(store.view()).toMatchObject({ pose: "asleep", caption: null });
});
test("control previews are rejected and query layout pins over state changes", () => {
  const store = createViewStore("compact");
  store.receive({
    type: "hello",
    role: "overlay",
    audio: false,
    channel: "synthetic_channel",
    state: { ...sceneState, layout: "stage" },
  });
  expect(store.view()).toMatchObject({ layout: "compact", channel: "synthetic_channel" });
  expect(
    store.receive({
      type: "preview",
      take: 1,
      text: "Never an overlay preview",
      dissent: null,
      pct: 50,
      voices: 2,
      holdMs: 1000,
      quiet: false,
    }),
  ).toBe(false);
});
