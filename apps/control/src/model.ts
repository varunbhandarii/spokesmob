import type { BeatSettings } from "../../../packages/core/src/beat-settings.js";
import { DEFAULT_BEAT_SETTINGS } from "../../../packages/core/src/beat-settings.js";
import type { BeatLogRecord, BeatView, HeldReason } from "../../../packages/core/src/beat-types.js";
import type { ControlAction, ControlMessage } from "../../../packages/core/src/overlay-protocol.js";

import { createPreviewState, type PreviewState, receivePreview } from "./preview.js";

export const LOG_LIMIT = 200;
type Cost = Extract<ControlMessage, { type: "cost" }>;
type Health = Extract<ControlMessage, { type: "health" }>;
export interface ControlModel {
  state: BeatView | null;
  preview: PreviewState;
  cost: Cost | null;
  health: Health | null;
  settings: BeatSettings;
  logs: BeatLogRecord[];
}
export const createControlModel = (): ControlModel => ({
  state: null,
  preview: createPreviewState(),
  cost: null,
  health: null,
  settings: { ...DEFAULT_BEAT_SETTINGS },
  logs: [],
});

export function mergeLogs(current: readonly BeatLogRecord[], incoming: readonly BeatLogRecord[]) {
  const rows = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()]
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id))
    .slice(0, LOG_LIMIT);
}
export function receiveControl(
  model: ControlModel,
  message: ControlMessage,
  now = 0,
): ControlModel {
  const preview = receivePreview(model.preview, message, now);
  const next = preview === model.preview ? model : { ...model, preview };
  switch (message.type) {
    case "hello":
      return { ...next, state: message.state };
    case "state": {
      const { type: _type, ...state } = message;
      return { ...next, state };
    }
    case "log":
      return { ...next, logs: mergeLogs(model.logs, [message.row]) };
    case "cost":
      return { ...next, cost: message };
    case "health":
      return { ...next, health: message };
    default:
      return next;
  }
}

const HELD_LABELS: Record<HeldReason, string> = {
  muted: "Muted",
  killed: "Kill switch is on",
  off: "Loop is off",
  offline: "Stream is offline",
  capped: "Spend cap reached",
  no_audio_client: "Waiting for an overlay client",
  overlay_inactive: "OBS audio source is inactive",
};
export function heldLabels(state: BeatView | null): string[] {
  return state ? state.heldBy.map((reason) => HELD_LABELS[reason]) : ["Waiting for server state"];
}
export function shortcutAction(
  key: string,
  options: { editing: boolean; modifier: boolean; repeat: boolean },
): ControlAction | null {
  if (options.editing || options.modifier || options.repeat) return null;
  switch (key.toLowerCase()) {
    case "v":
      return { action: "veto" };
    case "s":
      return { action: "speak" };
    case "m":
      return { action: "mute", minutes: 5 };
    case "k":
      return { action: "kill" };
    case "u":
      return { action: "unmute" };
    default:
      return null;
  }
}
export function canSendAction(
  action: ControlAction,
  state: BeatView | null,
  connected: boolean,
): boolean {
  if (!connected || !state) return false;
  if (action.action === "speak")
    return state.mode === "demand" && state.step === "listening" && state.heldBy.length === 0;
  if (action.action === "veto") return state.step === "preview" || state.step === "speaking";
  return true;
}
export function spendView(cost: Cost | null) {
  if (!cost) return { session: "—", hourly: "—", cap: "—", percent: 0 };
  return {
    session: `$${cost.usdSession.toFixed(4)}`,
    hourly: `$${cost.usdHour.toFixed(4)}`,
    cap: `$${cost.cap.toFixed(2)}`,
    percent: cost.cap > 0 ? Math.min(100, (cost.usdSession / cost.cap) * 100) : 100,
  };
}
export function codeLabel(value: string | null): string {
  if (!value) return "—";
  return /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value.replaceAll("_", " ") : "Details unavailable";
}
export function commandFailure(reason: string | null): string {
  switch (reason) {
    case "blocked_term":
      return "That text was blocked by the channel's safety rules.";
    case "moderation_flagged":
      return "That text did not pass moderation.";
    case "moderation_error":
      return "Moderation is unavailable. Nothing was published.";
    case "audio_client_required":
      return "Connect and activate the OBS audio source first.";
    case "voice_check_busy":
      return "Another voice check is still running.";
    default:
      return "The command was not applied. Check the beat log and connection.";
  }
}

export interface SettingsDraft {
  revision: number;
  dirty: boolean;
  pending: { request: string; revision: number } | null;
}
export function updateSettingsDraft(
  draft: SettingsDraft,
  event:
    | { type: "edit" }
    | { type: "save"; request: string }
    | { type: "result"; request: string; ok: boolean },
): SettingsDraft {
  if (event.type === "edit") return { ...draft, revision: draft.revision + 1, dirty: true };
  if (event.type === "save")
    return { ...draft, pending: { request: event.request, revision: draft.revision } };
  if (draft.pending?.request !== event.request) return draft;
  return { ...draft, pending: null, dirty: !event.ok || draft.pending.revision !== draft.revision };
}
