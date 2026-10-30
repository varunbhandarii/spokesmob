import {
  beatModeSchema,
  beatSettingsPatchSchema,
} from "../../../packages/core/src/beat-settings.js";
import type { BeatLogRecord } from "../../../packages/core/src/beat-types.js";
import { layoutSchema } from "../../../packages/core/src/beat-types.js";
import type { ControlAction } from "../../../packages/core/src/overlay-protocol.js";
import { collectLog, createControlApi } from "./api.js";
import { type ControlConnection, connectControl } from "./connection.js";
import {
  canSendAction,
  codeLabel,
  commandFailure,
  createControlModel,
  heldLabels,
  mergeLogs,
  receiveControl,
  type SettingsDraft,
  shortcutAction,
  spendView,
  updateSettingsDraft,
} from "./model.js";
import { createPreviewCard } from "./preview-card.js";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error("Control view is unavailable");
  return value as T;
}
const notice = element("notice");
const settingsForm = element<HTMLFormElement>("settings-form");
const questionForm = element<HTMLFormElement>("question-form");
const questionInput = element<HTMLTextAreaElement>("question-input");
const offline = element<HTMLInputElement>("test-offline");
const layout = element<HTMLSelectElement>("layout");
const exportButton = element<HTMLButtonElement>("export-log");
const fields = [
  { key: "windowS", label: "Window · seconds", min: 5, max: 20, step: "any" },
  { key: "minVoices", label: "Minimum voices", min: 1, max: 10, step: 1 },
  { key: "holdMs", label: "Preview · milliseconds", min: 500, max: 3000, step: 1 },
  { key: "cooldownS", label: "Cooldown · seconds", min: 0, max: 10, step: "any" },
  { key: "pinS", label: "Pin · seconds", min: 30, max: 1800, step: 1 },
  { key: "spendCapUsd", label: "Session cap · USD", min: 0, max: null, step: "any" },
  { key: "muteDefaultMin", label: "Default mute · minutes", min: 1, max: 60, step: 1 },
  { key: "logRetentionDays", label: "Log retention · days", min: 0, max: 30, step: 1 },
] as const;
for (const field of fields) {
  const label = document.createElement("label");
  label.className = "setting-row";
  label.textContent = field.label;
  const input = document.createElement("input");
  input.name = field.key;
  input.type = "number";
  input.required = true;
  input.min = String(field.min);
  if (field.max !== null) input.max = String(field.max);
  input.step = String(field.step);
  label.append(input);
  element("settings-fields").append(label);
}
const settingInput = (name: string) =>
  settingsForm.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
let model = createControlModel();
let connected = false;
let connection: ControlConnection | null = null;
let api: ReturnType<typeof createControlApi> | null = null;
let draft: SettingsDraft = { revision: 0, dirty: false, pending: null };
let stateVersion = 0;
let refreshVersion = 0;
let renderedLogs: readonly BeatLogRecord[] | null = null;
let exporting = false;
const notify = (message: string, error = false) => {
  notice.hidden = false;
  notice.dataset.error = String(error);
  notice.textContent = message;
};
function dispatch(action: ControlAction): string | null {
  if (!canSendAction(action, model.state, connected)) return null;
  const request = connection?.command(action) ?? null;
  if (!request) notify("The control connection is unavailable. No command was queued.", true);
  return request;
}
const previewCard = createPreviewCard(element("preview-card"), () => {
  dispatch({ action: "veto" });
});
const BUTTON_ACTIONS: Record<string, ControlAction> = {
  on: { action: "on" },
  off: { action: "off" },
  veto: { action: "veto" },
  speak: { action: "speak" },
  mute: { action: "mute", minutes: 5 },
  unmute: { action: "unmute" },
  kill: { action: "kill" },
  clear: { action: "clear" },
};
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) {
  button.addEventListener("click", () => {
    const action = BUTTON_ACTIONS[button.dataset.action ?? ""];
    if (action) dispatch(action);
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
  button.addEventListener("click", () => {
    const mode = beatModeSchema.safeParse(button.dataset.mode);
    if (mode.success) dispatch({ action: "mode", mode: mode.data });
  });
}
element("test-tone").addEventListener("click", () => {
  if (connection?.tone()) notify("Test tone requested.");
});
offline.addEventListener("change", () => {
  dispatch({ action: "testOffline", enabled: offline.checked });
  render();
});
layout.addEventListener("change", () => {
  const value = layoutSchema.safeParse(layout.value);
  if (value.success) dispatch({ action: "layout", layout: value.data });
});
questionForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (question) dispatch({ action: "question", question });
});
settingsForm.addEventListener("input", () => {
  draft = updateSettingsDraft(draft, { type: "edit" });
  element("settings-draft").hidden = false;
});
settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const values: Record<string, unknown> = { postLines: settingInput("postLines").value };
  for (const field of fields) values[field.key] = Number(settingInput(field.key).value);
  const parsed = beatSettingsPatchSchema.safeParse(values);
  if (!parsed.success) {
    notify("Check the setting ranges before saving.", true);
    return;
  }
  const request = dispatch({ action: "settings", changes: parsed.data });
  if (request) draft = updateSettingsDraft(draft, { type: "save", request });
});
document.addEventListener("keydown", (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const action = shortcutAction(event.key, {
    editing: !!target?.closest("input,textarea,select,[contenteditable=true]"),
    modifier: event.altKey || event.ctrlKey || event.metaKey,
    repeat: event.repeat,
  });
  if (action && canSendAction(action, model.state, connected)) {
    event.preventDefault();
    dispatch(action);
  }
});

function renderLog() {
  if (renderedLogs === model.logs) return;
  renderedLogs = model.logs;
  const container = element("beat-log");
  const expanded = new Set(
    [...container.querySelectorAll<HTMLDetailsElement>("details[open]")].map(
      (row) => row.dataset.id,
    ),
  );
  container.replaceChildren();
  if (!model.logs.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Completed beats will appear here.";
    container.append(empty);
    return;
  }
  for (const row of model.logs) {
    const item = document.createElement("details");
    item.className = "log-row";
    item.dataset.id = row.id;
    item.dataset.problem = String(["suppressed", "blocked", "vetoed"].includes(row.status));
    item.open = expanded.has(row.id);
    const summary = document.createElement("summary");
    const meta = document.createElement("div");
    meta.className = "log-meta";
    const time = document.createElement("time");
    time.dateTime = new Date(row.at).toISOString();
    time.textContent = new Date(row.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const outcome = document.createElement("span");
    outcome.className = "outcome";
    outcome.textContent = `${row.simulated ? "Simulated · " : ""}${codeLabel(row.status)}`;
    const duration = document.createElement("span");
    duration.textContent = row.e2eMs === null ? "e2e —" : `${row.e2eMs.toFixed(0)} ms`;
    meta.append(time, outcome, duration);
    const text = document.createElement("div");
    text.className = "log-line";
    text.textContent = row.line ?? codeLabel(row.reason);
    summary.append(meta, text);
    const detail = document.createElement("div");
    detail.className = "log-detail";
    for (const value of [
      `${row.pct}% of ${row.voices} voices · ${row.mode} · ${row.kind}`,
      `Gate: ${codeLabel(row.gate)} · Reason: ${codeLabel(row.reason)}`,
      row.dissent ? `Dissent: ${row.dissent}` : null,
      row.costUsd === null
        ? "Cost unknown"
        : `Cost $${row.costUsd.toFixed(6)}${row.unknownCost ? " + unknown usage" : ""}`,
    ]) {
      if (!value) continue;
      const line = document.createElement("p");
      line.textContent = value;
      detail.append(line);
    }
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy beat";
    copy.addEventListener("click", () => void copyBeat(row.id, copy));
    detail.append(copy);
    item.append(summary, detail);
    container.append(item);
  }
}
function render() {
  previewCard.update(model, connected);
  const state = model.state;
  element("beat-step").textContent = state?.step ?? "waiting";
  const online = element("online");
  online.textContent = state?.online ? "live" : "offline";
  online.dataset.online = String(state?.online ?? false);
  element("mood").textContent = state?.hype
    ? `hype · level ${state.hype.level}${state.hype.shared ? " · shared" : ""}`
    : (state?.mood ?? "");
  const held = element("held-by");
  held.replaceChildren();
  const reasons = heldLabels(state);
  held.classList.toggle("ready", reasons.length === 0);
  for (const text of reasons.length ? reasons : ["Ready for the next beat"]) {
    const li = document.createElement("li");
    li.textContent = text;
    held.append(li);
  }
  const cost = spendView(model.cost);
  element("cost-session").textContent = cost.session;
  element("cost-cap").textContent = cost.cap;
  element("cost-hour").textContent = cost.hourly;
  element<HTMLProgressElement>("cost-progress").value = cost.percent;
  const e2e = model.health?.e2eMs ?? model.logs[0]?.e2eMs;
  element("latest-e2e").textContent =
    e2e === null || e2e === undefined ? "—" : `${(e2e / 1000).toFixed(2)} s`;
  element("current-question").textContent = state?.question ?? "No active question";
  element("offline-warning").hidden = !state?.testOffline;
  offline.checked = state?.testOffline ?? false;
  offline.disabled = !connected || !state;
  if (state) layout.value = state.layout;
  layout.disabled = !connected || !state;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action]")) {
    const action = BUTTON_ACTIONS[button.dataset.action ?? ""];
    button.disabled = !action || !canSendAction(action, state, connected);
    if (action?.action === "on") button.disabled ||= state?.step !== "off";
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-mode]")) {
    button.disabled = !connected || !state;
    button.setAttribute("aria-pressed", String(button.dataset.mode === state?.mode));
  }
  element<HTMLButtonElement>("test-tone").disabled = !connected;
  for (const button of document.querySelectorAll<HTMLButtonElement>("form button[type=submit]"))
    button.disabled = !connected || !state;
  if (!draft.dirty) {
    for (const field of fields) settingInput(field.key).value = String(model.settings[field.key]);
    settingInput("postLines").value = model.settings.postLines;
  }
  element("settings-draft").hidden = !draft.dirty;
  const health = element("health");
  health.replaceChildren();
  if (model.health) {
    const value = model.health;
    for (const [text, ok] of [
      ["Twitch auth", value.twitchAuth.ok],
      [`Events ${codeLabel(value.eventSub.state)}`, value.eventSub.connected],
      [
        `Subs ${value.subscriptions.enabled}/${value.subscriptions.total}`,
        value.subscriptions.enabled === value.subscriptions.total,
      ],
      ["Main voice", value.realtime.main.ok],
      ["Dissent voice", value.realtime.dissent.ok],
      ["OBS audio", value.audioClient.connected && value.audioClient.active],
    ] as const) {
      const li = document.createElement("li");
      li.textContent = text;
      li.dataset.ok = String(ok);
      health.append(li);
    }
  }
  renderLog();
}
async function resync(includeLog: boolean) {
  if (!api) return;
  const version = stateVersion;
  const refresh = ++refreshVersion;
  const results = await Promise.allSettled([
    api.state(),
    includeLog ? api.recent() : Promise.resolve(null),
  ] as const);
  if (refresh !== refreshVersion) return;
  const snapshot = results[0];
  if (snapshot?.status === "fulfilled")
    model = {
      ...model,
      settings: snapshot.value.settings,
      state: version === stateVersion ? snapshot.value.state : model.state,
    };
  const log = results[1];
  if (log?.status === "fulfilled" && log.value)
    model = { ...model, logs: mergeLogs(model.logs, log.value) };
  if (snapshot?.status === "rejected")
    notify("Settings could not be refreshed. Your draft is preserved.", true);
  render();
}
async function copyBeat(id: string, button: HTMLButtonElement) {
  if (!api) return;
  button.disabled = true;
  try {
    const rows = await collectLog(api.logs, { findId: id });
    const row = rows.find((value) => value.id === id);
    if (!row) throw new Error("Beat unavailable");
    await navigator.clipboard.writeText(JSON.stringify(row, null, 2));
    notify("Full beat record copied.");
  } catch {
    notify(
      "Could not copy the full beat record. It may have expired or clipboard access may be unavailable.",
      true,
    );
  } finally {
    button.disabled = false;
  }
}
exportButton.addEventListener("click", () => {
  if (!api || exporting) return;
  exporting = true;
  exportButton.disabled = true;
  exportButton.textContent = "Exporting…";
  void collectLog(api.logs)
    .then((rows) => {
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `spokesmob-log-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      notify(`Exported ${rows.length} retained beat records.`);
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "";
      notify(
        reason === "Log export is too large"
          ? "The export exceeds this browser's safe download size. No partial export was saved."
          : reason === "Log pagination did not advance"
            ? "Log pagination stalled. No partial export was saved."
            : "The log could not be exported. No partial export was saved.",
        true,
      );
    })
    .finally(() => {
      exporting = false;
      exportButton.disabled = false;
      exportButton.textContent = "Export log";
    });
});

render();
try {
  api = createControlApi({ location: window.location });
  connection = connectControl({
    location: window.location,
    state: (value) => {
      connected = value === "connected";
      const badge = element("connection");
      badge.textContent = value;
      badge.dataset.connected = String(connected);
      render();
    },
    message: (message) => {
      model = receiveControl(model, message, performance.now());
      if (message.type === "hello" || message.type === "state") stateVersion++;
      if (message.type === "hello") void resync(true);
      if (message.type === "result") {
        if (message.ok) {
          notify("Control updated.");
        } else notify(commandFailure(message.reason), true);
        draft = updateSettingsDraft(draft, {
          type: "result",
          request: message.request,
          ok: message.ok,
        });
        void resync(false);
      }
      if (message.type === "voice_result")
        notify(
          message.data.status === "verified"
            ? "Test tone verified."
            : "Test tone did not complete. Check the OBS audio source.",
          message.data.status !== "verified",
        );
      render();
    },
  });
} catch {
  notify("Open the control URL copied by the local server to authorize this dock.", true);
}
window.addEventListener("pagehide", () => {
  connection?.close();
  previewCard.destroy();
});
