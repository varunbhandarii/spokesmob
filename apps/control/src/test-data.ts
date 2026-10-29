import type { BeatLogRecord, BeatView } from "../../../packages/core/src/beat-types.js";

export const view: BeatView = {
  step: "listening",
  mode: "demand",
  muted: false,
  mutedUntil: null,
  online: true,
  testOffline: false,
  capped: false,
  heldBy: [],
  question: null,
  layout: "wide",
  mood: null,
  hype: null,
};
export function row(id: number): BeatLogRecord {
  return {
    id: `beat-${id}`,
    at: id,
    kind: "consensus",
    mode: "auto",
    status: "spoken",
    gate: null,
    reason: null,
    line: "Some of chat says blue.",
    dissent: null,
    pct: 40,
    voices: 10,
    mood: "chill",
    citedExemplars: ["blue"],
    citedNames: ["Viewer"],
    latency: {
      assemblyMs: 1,
      moderationMs: 1,
      modelMs: 600,
      verifierMs: 1,
      holdMs: 1000,
      voiceReadyMs: 700,
      preRollMs: 100,
    },
    e2eMs: 1703,
    voiceAttempts: [],
    costUsd: 0.001,
    unknownCost: false,
  };
}
