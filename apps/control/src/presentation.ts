import type { BeatLogRecord } from "../../../packages/core/src/beat-types.js";
import { formatVoiceCount } from "../../../packages/core/src/voice-count.js";
import { type ControlModel, codeLabel } from "./model.js";

export function dockStatus(model: ControlModel, connected: boolean): string {
  const state = model.state;
  if (!connected || !state) return "Connecting";
  if (state.muted || state.heldBy.includes("killed")) return "Muted";
  if (state.step === "off") return "Turned off";
  if (state.heldBy.includes("offline")) return "Offline";
  if (state.heldBy.some((reason) => ["no_audio_client", "overlay_inactive"].includes(reason)))
    return "Waiting for OBS";
  if (state.capped) return "Spend cap reached";
  return {
    listening: state.online ? "Live \u00b7 listening" : "Test \u00b7 listening",
    synthesizing: "Finding a line",
    preview: "Line ready",
    speaking: "Speaking",
    cooldown: "Taking a breath",
    held: "Waiting",
  }[state.step];
}

export function healthItems(model: ControlModel): readonly (readonly [string, boolean])[] {
  const value = model.health;
  return value
    ? [
        ["Twitch auth", value.twitchAuth.ok],
        ["Chat events", value.eventSub.connected],
        [
          `Subs ${value.subscriptions.enabled}/${value.subscriptions.total}`,
          value.subscriptions.enabled === value.subscriptions.total,
        ],
        ["Main voice", value.realtime.main.ok],
        ["Dissent voice", value.realtime.dissent.ok],
        ["OBS audio", value.audioClient.connected && value.audioClient.active],
      ]
    : [];
}

export function chatterSnapshot(model: ControlModel): string {
  const current = model.state?.step === "preview" ? model.preview.notice : null;
  const line = current ?? model.logs.find((row) => !!row.line);
  return line
    ? `${line.voices} chatting (${current ? "window" : "last window"})`
    : "Waiting for a chat window";
}

export function logFacts(row: BeatLogRecord): string {
  const pin =
    row.gate === "pin"
      ? "pin failed"
      : row.gate === "chat"
        ? "not posted"
        : row.kind === "event"
          ? "event"
          : "pin unreported";
  return `${row.pct}% of ${formatVoiceCount(row.voices)} \u00b7 ${pin}${row.reason ? ` \u00b7 ${codeLabel(row.reason)}` : ""}`;
}
