import {
  type BeatView,
  beatViewSchema,
  type Layout,
} from "../../../../packages/core/src/beat-types.js";
import {
  type AudioChannel,
  type LineMessage,
  type OverlayMessage,
  type PlaybackReport,
  playbackReportSchema,
  resolveOverlayLayout,
  serverOverlayMessageSchema,
} from "../../../../packages/core/src/overlay-protocol.js";
import type { FacePose } from "../face/types.js";

export interface VisibleCaption {
  line: LineMessage;
  source: "started" | "reveal";
  dissent: boolean;
}
export interface OverlayView {
  state: BeatView;
  layout: Layout;
  channel: string;
  pose: FacePose;
  caption: VisibleCaption | null;
  voices: number;
  messages: number;
  active: boolean;
  rms: number;
  audioChannel: AudioChannel | null;
  newestName: string | null;
}
const initial: BeatView = {
  step: "off",
  mode: "auto",
  muted: false,
  mutedUntil: null,
  online: false,
  testOffline: false,
  capped: false,
  heldBy: ["off", "offline", "no_audio_client"],
  question: null,
  layout: "wide",
  mood: null,
  hype: null,
};
export function createViewStore(queryLayout: string | null = null) {
  let state = { ...initial };
  let channel = "spokesmob";
  let pose: FacePose = "asleep";
  let active = true;
  let pending: LineMessage | null = null;
  let caption: VisibleCaption | null = null;
  let playing: number | null = null;
  let audioChannel: AudioChannel | null = null;
  let voices = 0;
  let messages = 0;
  let rms = 0;
  let newestName: string | null = null;
  const prepared = new Map<number, { channel: AudioChannel; text: string }>();
  const cancelled = new Set<number>();
  let stoppedThrough = -1;
  let highestSeen = -1;
  let newestLineTake = -1;
  let clearedByStop = false;
  const stopped = (take: number) =>
    take <= stoppedThrough || cancelled.has(take) || take < newestLineTake;
  const held = () =>
    !active ||
    state.step === "off" ||
    state.capped ||
    (!state.online && !state.testOffline) ||
    state.heldBy.some((reason) => reason !== "muted" && reason !== "killed");
  const clear = () => {
    pending = null;
    caption = null;
    playing = null;
    audioChannel = null;
    rms = 0;
  };
  const stop = (take: number | "all") => {
    const affected = take === "all" || pending?.take === take || playing === take;
    if (take === "all") {
      stoppedThrough = Math.max(stoppedThrough, highestSeen);
      for (const id of prepared.keys()) cancelled.add(id);
      if (pending) cancelled.add(pending.take);
      clear();
      prepared.clear();
    } else {
      cancelled.add(take);
      prepared.delete(take);
      if (pending?.take === take || playing === take) clear();
    }
    if (affected) {
      pose = "idle";
      clearedByStop = true;
    }
  };
  return {
    receive(value: unknown): boolean {
      const parsed = serverOverlayMessageSchema.safeParse(value);
      if (!parsed.success) return false;
      const event: OverlayMessage = parsed.data;
      if ("take" in event && typeof event.take === "number")
        highestSeen = Math.max(highestSeen, event.take);
      switch (event.type) {
        case "hello":
          cancelled.clear();
          prepared.clear();
          clear();
          stoppedThrough = -1;
          highestSeen = -1;
          newestLineTake = -1;
          clearedByStop = false;
          state = event.state;
          channel = event.channel;
          pose = state.step === "synthesizing" ? "thinking" : "idle";
          break;
        case "state":
          state = beatViewSchema.strip().parse(event);
          if (
            state.muted ||
            state.heldBy.includes("muted") ||
            state.heldBy.includes("killed") ||
            held()
          ) {
            stop("all");
          } else if (state.step === "listening") pose = "idle";
          else if (state.step === "synthesizing") {
            pose = "thinking";
            clearedByStop = false;
          } else if (state.step === "preview") {
            caption = null;
            playing = null;
            audioChannel = null;
            rms = 0;
            pose = "inhale";
            clearedByStop = false;
          } else if (state.step === "cooldown") {
            if (caption?.source === "reveal") {
              caption = null;
              pending = null;
            }
            pose = clearedByStop ? "idle" : "settle";
          }
          break;
        case "line":
          if (!stopped(event.take) && event.take > newestLineTake) {
            newestLineTake = event.take;
            clearedByStop = false;
            for (const id of cancelled) if (id < newestLineTake) cancelled.delete(id);
            pending = event;
            caption = null;
            playing = null;
            audioChannel = null;
            pose = "inhale";
          }
          break;
        case "prepare":
          if (!stopped(event.take)) {
            prepared.set(event.take, { channel: event.channel, text: event.text });
            while (prepared.size > 32) prepared.delete(prepared.keys().next().value as number);
          }
          break;
        case "reveal":
          if (pending?.take === event.take && !stopped(event.take) && !held() && !state.muted) {
            caption = { line: pending, source: "reveal", dissent: false };
            pose = "reading";
          }
          break;
        case "stop":
          stop(event.take);
          break;
        case "veto":
          stop(event.take);
          break;
        case "listening":
          voices = event.voices;
          messages = event.messages;
          break;
        case "particles":
          newestName = event.names.at(-1) ?? newestName;
          break;
        case "particles_clear":
          newestName = null;
          break;
      }
      return true;
    },
    playback(value: PlaybackReport) {
      const parsed = playbackReportSchema.safeParse(value);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.type === "stopped") {
        stop(event.take);
        return;
      }
      if (stopped(event.take)) return;
      const take = prepared.get(event.take);
      if (event.type === "started" && take && !held() && !state.muted) {
        playing = event.take;
        audioChannel = take.channel;
        if (take.channel === "main") {
          if (!pending || pending.take !== event.take || pending.text !== take.text)
            pending = {
              type: "line",
              take: event.take,
              text: take.text,
              dissent: null,
              dissentPct: null,
              pct: 0,
              voices: 0,
              mood: state.mood ?? "chill",
              question: state.question,
              answersQuestion: true,
              templated: true,
              citedNames: [],
              holdMs: 1000,
              quiet: false,
            };
          caption = { line: pending, source: "started", dissent: false };
          pose = "speaking";
        } else {
          if (caption) caption.dissent = true;
          pose = "aside";
        }
      } else if (event.type === "ended" && playing === event.take) {
        playing = null;
        audioChannel = null;
        rms = 0;
        pose = "settle";
      }
    },
    setActive(value: boolean) {
      active = value;
      if (!value) stop("all");
    },
    disconnected() {
      stop("all");
      state = { ...state, heldBy: [...new Set([...state.heldBy, "no_audio_client" as const])] };
    },
    sample(value: number) {
      rms = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
    },
    view(): OverlayView {
      const blocked =
        state.muted || state.heldBy.includes("muted") || state.heldBy.includes("killed");
      return {
        state,
        layout: resolveOverlayLayout(queryLayout, state.layout),
        channel,
        pose: blocked ? "muted" : held() ? "asleep" : pose,
        caption: blocked || held() ? null : caption,
        voices,
        messages,
        active,
        rms,
        audioChannel,
        newestName,
      };
    },
  };
}
export type ViewStore = ReturnType<typeof createViewStore>;
