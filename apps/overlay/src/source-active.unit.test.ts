import { expect, test } from "vitest";
import { overlayStatusVisible, sourceActive, sourceAudioStatus } from "./source-active.js";

test("only connected and ready audio hides the production status", () => {
  expect(overlayStatusVisible("connected", "audio ready")).toBe(false);
  for (const connection of ["connecting", "disconnected", "unavailable"])
    expect(overlayStatusVisible(connection, "audio ready")).toBe(true);
  for (const audio of ["waiting for audio", "preview, silent", "audio blocked", "source inactive"])
    expect(overlayStatusVisible("connected", audio)).toBe(true);
});

test("OBS output status never changes source activity", () => {
  const status = {
    recording: true,
    recordingPaused: false,
    streaming: false,
    replaybuffer: false,
    virtualcam: true,
  };
  expect(sourceActive(true, status)).toBe(true);
  expect(sourceActive(false, status)).toBe(false);
  expect(sourceActive(true, { type: "outputStatus", detail: { ...status, active: false } })).toBe(
    true,
  );
});

test("only a boolean source-active event toggles activity", () => {
  let active = true;
  active = sourceActive(active, { type: "obsSourceActiveChanged", detail: { active: false } });
  expect(active).toBe(false);
  active = sourceActive(active, { type: "obsSourceActiveChanged", detail: { active: true } });
  expect(active).toBe(true);
  for (const detail of [
    undefined,
    null,
    {},
    { active: undefined },
    { active: 0 },
    { active: "false" },
  ]) {
    expect(sourceActive(true, { type: "obsSourceActiveChanged", detail })).toBe(true);
    expect(sourceActive(false, { type: "obsSourceActiveChanged", detail })).toBe(false);
  }
});

test("hello status describes active and inactive authorized sources accurately", () => {
  expect(sourceAudioStatus(true, true, true)).toBe("audio ready");
  expect(sourceAudioStatus(true, true, false)).toBe("source inactive");
  expect(sourceAudioStatus(false, true, true)).toBe("preview, silent");
  expect(sourceAudioStatus(true, false, false)).toBe("preview, silent");
});
