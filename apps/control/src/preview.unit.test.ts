import { expect, test } from "vitest";
import { createPreviewState, type PreviewNotice, previewView, receivePreview } from "./preview.js";
import { row, view } from "./test-data.js";

const notice: PreviewNotice = {
  type: "preview",
  take: 7,
  text: "Chat wants Gary.",
  dissent: "Some prefer Milo.",
  dissentPct: 18,
  pct: 71,
  voices: 312,
  holdMs: 1000,
  quiet: false,
};
test("preview metadata arriving before state starts one bounded countdown", () => {
  const preview = receivePreview(createPreviewState(), notice, 100);
  expect(previewView(preview, view, true, 200).kind).toBe("hidden");
  const state = { ...view, step: "preview" as const };
  expect(previewView(preview, state, true, 350)).toMatchObject({
    kind: "preview",
    text: notice.text,
    dissent: "18% \u00b7 Some prefer Milo.",
    summary: "71% of 312 voices",
    remainingMs: 750,
    progress: 0.75,
  });
  expect(previewView(preview, state, true, 1300)).toMatchObject({
    kind: "preview",
    remainingMs: 0,
  });
  expect(receivePreview(preview, notice, 900)).toBe(preview);
});
test("leaving preview or losing the connection hides its text immediately", () => {
  const preview = receivePreview(createPreviewState(), notice, 0);
  expect(previewView(preview, { ...view, step: "preview" }, false, 200).kind).toBe("hidden");
  for (const step of [
    "off",
    "listening",
    "synthesizing",
    "speaking",
    "cooldown",
    "held",
  ] as const) {
    const next = receivePreview(preview, { type: "state", ...view, step }, 200);
    expect(next.notice).toBeNull();
    expect(previewView(next, { ...view, step }, true, 200).kind).toBe("hidden");
  }
});
test("a confirmed veto displays for two seconds and duplicate logs do not extend it", () => {
  const log = { type: "log" as const, row: { ...row(1), status: "vetoed" as const } };
  const preview = receivePreview(createPreviewState(), log, 100);
  expect(previewView(preview, view, true, 2099).kind).toBe("vetoed");
  expect(previewView(preview, view, true, 2100).kind).toBe("hidden");
  expect(receivePreview(preview, log, 1500)).toBe(preview);
  const next = receivePreview(preview, { ...notice, quiet: true }, 500);
  expect(previewView(next, { ...view, step: "preview" }, true, 600)).toMatchObject({
    kind: "preview",
    quiet: true,
  });
});
test("hello discards previews from the prior connection", () => {
  const preview = receivePreview(createPreviewState(), notice, 0);
  const next = receivePreview(
    preview,
    { type: "hello", role: "control", audio: false, state: view },
    1,
  );
  expect(next).toEqual(createPreviewState());
});
