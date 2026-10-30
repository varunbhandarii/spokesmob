import type { BeatView } from "../../../../packages/core/src/beat-types.js";
import type {
  LineMessage,
  OverlayMessage,
  PlaybackReport,
} from "../../../../packages/core/src/overlay-protocol.js";

export const SCENES = [
  "listening",
  "thinking",
  "preview",
  "speaking",
  "dissent",
  "captions-only",
  "caption-fallback",
  "veto",
  "muted",
  "asleep",
  "hype",
] as const;
export type Scene = (typeof SCENES)[number];
export interface SceneFrame {
  at: number;
  message?: OverlayMessage;
  playback?: PlaybackReport;
}
export const sceneState: BeatView = {
  step: "listening",
  mode: "auto",
  online: true,
  testOffline: false,
  muted: false,
  mutedUntil: null,
  capped: false,
  heldBy: [],
  question: "Name the cat?",
  layout: "wide",
  mood: "chill",
  hype: null,
};
export const sceneLine: LineMessage = {
  type: "line",
  take: 1,
  text: "Most of chat wants Gary.",
  dissent: "Some prefer Milo.",
  dissentPct: 18,
  pct: 71,
  voices: 312,
  mood: "chill",
  question: "Name the cat?",
  answersQuestion: true,
  templated: false,
  citedNames: ["LanternFox", "MossPilot", "SilverFinch"],
  holdMs: 1000,
  quiet: false,
};
export function sceneFrames(scene: Scene): SceneFrame[] {
  const frames: SceneFrame[] = [
    {
      at: 0,
      message: {
        type: "hello",
        role: "overlay",
        audio: false,
        channel: "synthetic_channel",
        state: sceneState,
      },
    },
    { at: 0, message: { type: "listening", voices: 312, messages: 680, windowMs: 8000 } },
    { at: 0, message: { type: "particles", names: ["LanternFox", "MossPilot", "SilverFinch"] } },
  ];
  if (scene === "listening") return frames;
  if (scene === "thinking")
    return [
      ...frames,
      { at: 100, message: { type: "state", ...sceneState, step: "synthesizing" } },
    ];
  if (scene === "muted")
    return [
      ...frames,
      {
        at: 100,
        message: { type: "state", ...sceneState, step: "held", muted: true, heldBy: ["muted"] },
      },
    ];
  if (scene === "asleep")
    return [
      ...frames,
      {
        at: 100,
        message: { type: "state", ...sceneState, step: "held", online: false, heldBy: ["offline"] },
      },
    ];
  if (scene === "hype")
    return [
      ...frames,
      {
        at: 100,
        message: { type: "state", ...sceneState, mood: "hype", hype: { level: 3, shared: true } },
      },
    ];
  frames.push(
    {
      at: 100,
      message: {
        type: "state",
        ...sceneState,
        step: "preview",
        mode: scene === "captions-only" ? "quiet" : "auto",
      },
    },
    { at: 100, message: { ...sceneLine, quiet: scene === "captions-only" } },
  );
  if (scene === "preview") return frames;
  if (scene === "veto")
    return [
      ...frames,
      { at: 600, message: { type: "veto", take: 1 } },
      { at: 1100, message: { type: "reveal", take: 1 } },
      { at: 1100, playback: { type: "started", take: 1 } },
    ];
  if (scene === "captions-only")
    return [
      ...frames,
      { at: 1100, message: { type: "reveal", take: 1 } },
      { at: 1100, message: { type: "state", ...sceneState, step: "speaking", mode: "quiet" } },
    ];
  if (scene === "caption-fallback")
    return [
      ...frames,
      { at: 1100, message: { type: "stop", take: "all" } },
      { at: 1100, message: { ...sceneLine, take: 2 } },
      { at: 1100, message: { type: "reveal", take: 2 } },
      { at: 1100, message: { type: "state", ...sceneState, step: "speaking" } },
    ];
  frames.push(
    { at: 100, message: { type: "prepare", take: 1, channel: "main", text: sceneLine.text } },
    { at: 1100, message: { type: "play", take: 1, durationMs: 2500 } },
    { at: 1200, playback: { type: "started", take: 1 } },
  );
  if (scene === "dissent")
    frames.push(
      { at: 3700, playback: { type: "ended", take: 1 } },
      {
        at: 3700,
        message: { type: "prepare", take: 2, channel: "dissent", text: sceneLine.dissent ?? "" },
      },
      { at: 3800, message: { type: "play", take: 2, durationMs: 1500 } },
      { at: 3900, playback: { type: "started", take: 2 } },
    );
  return frames.sort((a, b) => a.at - b.at);
}
export const CAPTURE_AT: Record<Scene, number> = {
  listening: 200,
  thinking: 300,
  preview: 700,
  speaking: 1500,
  dissent: 4100,
  "captions-only": 1500,
  "caption-fallback": 1500,
  veto: 1500,
  muted: 300,
  asleep: 300,
  hype: 300,
};
