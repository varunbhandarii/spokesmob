import { expect, test } from "vitest";
import { sourceActive, sourceAudioStatus } from "./source-active.js";

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
