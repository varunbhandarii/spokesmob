import { expect, test } from "vitest";
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
import { row, view } from "./test-data.js";

test("hello restores step, effective mood and active train without requesting audio", () => {
  const model = createControlModel();
  const state = {
    ...view,
    step: "speaking" as const,
    mood: "hype" as const,
    hype: { level: 3, shared: true },
  };
  const next = receiveControl(model, { type: "hello", role: "control", audio: false, state });
  expect(next.state).toEqual(state);
  expect(model.state).toBe(null);
  expect(receiveControl(next, { type: "state", ...view }).state).toEqual(view);
});

test("logs replace duplicate IDs and retain the newest bounded records", () => {
  const original = Array.from({ length: 205 }, (_, index) => row(index));
  const updated = { ...row(204), status: "vetoed" as const, reason: "veto" };
  const result = mergeLogs(original, [updated]);
  expect(result).toHaveLength(200);
  expect(result[0]).toEqual(updated);
  expect(result.at(-1)?.id).toBe("beat-5");
  expect(original[204]?.status).toBe("spoken");
  const model = receiveControl(createControlModel(), { type: "log", row: row(1) });
  expect(model.logs[0]?.id).toBe("beat-1");
});

test("shortcuts ignore editing, modified keys and held-key repeats", () => {
  const clear = { editing: false, modifier: false, repeat: false };
  expect(shortcutAction("V", clear)).toEqual({ action: "veto" });
  expect(shortcutAction("s", clear)).toEqual({ action: "speak" });
  expect(shortcutAction("m", clear)).toEqual({ action: "mute", minutes: 5 });
  expect(shortcutAction("k", clear)).toEqual({ action: "kill" });
  expect(shortcutAction("u", clear)).toEqual({ action: "unmute" });
  for (const blocked of ["editing", "modifier", "repeat"] as const)
    expect(shortcutAction("k", { ...clear, [blocked]: true })).toBe(null);
  expect(shortcutAction("Enter", clear)).toBe(null);
});

test("speak requires an unblocked demand window while veto remains available during dissent", () => {
  expect(canSendAction({ action: "speak" }, view, true)).toBe(true);
  expect(canSendAction({ action: "speak" }, { ...view, mode: "auto" }, true)).toBe(false);
  expect(canSendAction({ action: "speak" }, { ...view, heldBy: ["muted"] }, true)).toBe(false);
  expect(canSendAction({ action: "veto" }, { ...view, step: "speaking" }, true)).toBe(true);
  expect(canSendAction({ action: "veto" }, { ...view, step: "cooldown" }, true)).toBe(false);
  expect(canSendAction({ action: "kill" }, view, false)).toBe(false);
  expect(canSendAction({ action: "kill" }, null, true)).toBe(false);
  expect(
    canSendAction(
      { action: "unmute" },
      { ...view, step: "held", muted: true, mutedUntil: 300000, heldBy: ["muted"] },
      true,
    ),
  ).toBe(true);
  expect(heldLabels({ ...view, heldBy: ["offline", "overlay_inactive"] })).toEqual([
    "Stream is offline",
    "OBS audio source is inactive",
  ]);
});

test("cost displays unknown as unavailable and bounds a zero or exceeded cap", () => {
  expect(spendView(null).session).toBe("—");
  expect(spendView({ type: "cost", usdSession: 1, usdHour: 2, cap: 0 }).percent).toBe(100);
  expect(spendView({ type: "cost", usdSession: 6, usdHour: 2, cap: 5 }).percent).toBe(100);
  expect(spendView({ type: "cost", usdSession: 1, usdHour: 2, cap: 5 }).percent).toBe(20);
  expect(codeLabel("not_enough_voices")).toBe("not enough voices");
  expect(codeLabel("unexpected remote body")).toBe("Details unavailable");
  expect(commandFailure("unexpected remote body")).not.toContain("unexpected");
});

test("a save acknowledgment preserves edits made while it was in flight and ignores older requests", () => {
  const clean: SettingsDraft = { revision: 0, dirty: false, pending: null };
  const edited = updateSettingsDraft(clean, { type: "edit" });
  const saving = updateSettingsDraft(edited, { type: "save", request: "save-1" });
  const editedAgain = updateSettingsDraft(saving, { type: "edit" });
  expect(
    updateSettingsDraft(editedAgain, { type: "result", request: "save-1", ok: true }).dirty,
  ).toBe(true);
  expect(updateSettingsDraft(saving, { type: "result", request: "save-1", ok: false }).dirty).toBe(
    true,
  );
  expect(updateSettingsDraft(saving, { type: "result", request: "old-save", ok: true })).toBe(
    saving,
  );
  expect(updateSettingsDraft(saving, { type: "result", request: "save-1", ok: true }).dirty).toBe(
    false,
  );
  expect(clean).toEqual({ revision: 0, dirty: false, pending: null });
});
