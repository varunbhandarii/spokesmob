import type { BeatView } from "../../../packages/core/src/beat-types.js";
import type { ControlMessage } from "../../../packages/core/src/overlay-protocol.js";

export type PreviewNotice = Extract<ControlMessage, { type: "preview" }>;
export interface PreviewState {
  notice: PreviewNotice | null;
  receivedAt: number;
  vetoedUntil: number;
  lastVeto: string | null;
}
export const createPreviewState = (): PreviewState => ({
  notice: null,
  receivedAt: 0,
  vetoedUntil: 0,
  lastVeto: null,
});

export function receivePreview(
  state: PreviewState,
  message: ControlMessage,
  now: number,
): PreviewState {
  if (message.type === "hello") return createPreviewState();
  if (message.type === "preview")
    return state.notice?.take === message.take
      ? state
      : {
          ...state,
          notice: message,
          receivedAt: now,
          vetoedUntil: 0,
        };
  if (message.type === "state" && message.step !== "preview") return { ...state, notice: null };
  if (
    message.type === "log" &&
    message.row.status === "vetoed" &&
    message.row.id !== state.lastVeto
  )
    return { ...state, notice: null, vetoedUntil: now + 2000, lastVeto: message.row.id };
  return state;
}

export function previewView(
  preview: PreviewState,
  state: BeatView | null,
  connected: boolean,
  now: number,
) {
  const notice = preview.notice;
  const showing = connected && state?.step === "preview" && !!notice;
  const remainingMs = notice
    ? Math.max(0, notice.holdMs - Math.max(0, now - preview.receivedAt))
    : 0;
  return {
    kind: showing ? "preview" : connected && now < preview.vetoedUntil ? "vetoed" : "hidden",
    text: showing ? notice.text : "",
    dissent: showing ? notice.dissent : null,
    summary: showing ? `${String(notice.pct)}% of ${String(notice.voices)}` : "",
    quiet: showing && notice.quiet,
    remainingMs,
    progress: notice ? remainingMs / notice.holdMs : 0,
  } as const;
}
