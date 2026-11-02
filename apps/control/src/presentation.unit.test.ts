import { expect, test } from "vitest";
import { createControlModel } from "./model.js";
import { chatterSnapshot, dockStatus, healthItems, logFacts } from "./presentation.js";
import { row, view } from "./test-data.js";

test("dock language keeps safety holds ahead of ordinary step labels", () => {
  const model = { ...createControlModel(), state: { ...view } };
  expect(dockStatus(model, false)).toBe("Connecting");
  expect(dockStatus(model, true)).toBe("Live \u00b7 listening");
  model.state.step = "preview";
  expect(dockStatus(model, true)).toBe("Line ready");
  model.state.heldBy = ["no_audio_client"];
  expect(dockStatus(model, true)).toBe("Waiting for OBS");
  model.state.heldBy = ["offline"];
  expect(dockStatus(model, true)).toBe("Offline");
  model.state.muted = true;
  expect(dockStatus(model, true)).toBe("Muted");
});

test("count snapshots and pin facts describe only recorded evidence", () => {
  const model = createControlModel();
  expect(chatterSnapshot(model)).toBe("Waiting for a chat window");
  expect(healthItems(model)).toEqual([]);
  model.logs = [row(1)];
  expect(chatterSnapshot(model)).toBe("10 chatting (last window)");
  expect(logFacts(row(1))).toBe("40% of 10 voices \u00b7 pin unreported");
  expect(logFacts({ ...row(1), voices: 1, gate: "pin", reason: "helix_error" })).toBe(
    "40% of 1 voice \u00b7 pin failed \u00b7 helix error",
  );
});
