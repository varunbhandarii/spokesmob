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
import type { ParticleCue } from "./particles.js";
import { captionLingerMs, highlightedWord } from "./text.js";

export interface VisibleCaption {
  line: LineMessage;
  source: "started" | "reveal";
  dissent: boolean;
  ageMs: number;
  durationMs: number;
  positionMs: number;
  highlighted: number;
}
interface CaptionData {
  line: LineMessage;
  source: "started" | "reveal";
  dissent: boolean;
  shownAt: number;
  until: number | null;
}
interface PreparedTake {
  channel: AudioChannel;
  text: string;
  durationMs: number;
  positionMs: number;
  reportedAt: number;
  playing: boolean;
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
  raid: { name: string; viewers: number } | null;
  particles: readonly ParticleCue[];
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
export function createViewStore(
  queryLayout: string | null = null,
  now: () => number = () => performance.now(),
) {
  let state = { ...initial };
  let channel = "spokesmob";
  let pose: FacePose = "asleep";
  let active = true;
  let pending: LineMessage | null = null;
  let caption: CaptionData | null = null;
  let playing: number | null = null;
  let audioChannel: AudioChannel | null = null;
  let voices = 0;
  let messages = 0;
  let rms = 0;
  let newestName: string | null = null;
  let cueId = 0;
  let particleCues: ParticleCue[] = [];
  const cue = (type: ParticleCue["type"], names: readonly string[] = []) => {
    const next: ParticleCue = { id: ++cueId, type, names };
    particleCues =
      type === "clear"
        ? [next]
        : [
            ...(particleCues[0]?.type === "clear"
              ? [particleCues[0], ...particleCues.slice(1).slice(-126)]
              : particleCues.slice(-127)),
            next,
          ];
  };
  let raid: { name: string; viewers: number; until: number } | null = null;
  const revealed = new Set<number>();
  const prepared = new Map<number, PreparedTake>();
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
          revealed.clear();
          raid = null;
          cue("clear");
          prepared.clear();
          clear();
          stoppedThrough = -1;
          highestSeen = -1;
          newestLineTake = -1;
          clearedByStop = false;
          state = event.state;
          channel = event.channel;
          pose =
            state.step === "synthesizing"
              ? "thinking"
              : state.step === "preview"
                ? "inhale"
                : state.step === "cooldown"
                  ? "settle"
                  : "idle";
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
            for (const id of revealed) if (id < newestLineTake) revealed.delete(id);
            pending = event;
            caption = null;
            playing = null;
            audioChannel = null;
            pose = "inhale";
          }
          break;
        case "prepare":
          if (!stopped(event.take)) {
            prepared.set(event.take, {
              channel: event.channel,
              text: event.text,
              durationMs: 0,
              positionMs: 0,
              reportedAt: now(),
              playing: false,
            });
            while (prepared.size > 32) prepared.delete(prepared.keys().next().value as number);
          }
          break;
        case "play": {
          const take = prepared.get(event.take);
          if (take && !stopped(event.take)) take.durationMs = event.durationMs;
          break;
        }
        case "reveal":
          if (
            pending?.take === event.take &&
            !revealed.has(event.take) &&
            !stopped(event.take) &&
            !held() &&
            !state.muted
          ) {
            revealed.add(event.take);
            caption = {
              line: pending,
              source: "reveal",
              dissent: false,
              shownAt: now(),
              until: now() + captionLingerMs(pending.text),
            };
            pose = "reading";
          }
          break;
        case "event":
          if (event.kind === "raid")
            raid = { name: event.name, viewers: event.viewers, until: now() + 6000 };
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
          cue("spawn", event.names);
          newestName = event.names.at(-1) ?? newestName;
          break;
        case "particles_clear":
          cue("clear");
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
        take.playing = true;
        take.positionMs = 0;
        take.reportedAt = now();
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
          caption = {
            line: pending,
            source: "started",
            dissent: false,
            shownAt: now(),
            until: null,
          };
          pose = "speaking";
          cue("gather", pending.citedNames);
        } else {
          if (caption) {
            caption.dissent = true;
            caption.until = null;
          }
          pose = "aside";
        }
      } else if (event.type === "played" && take && playing === event.take) {
        take.positionMs = event.samples / 24;
        take.reportedAt = now();
      } else if (event.type === "ended" && playing === event.take) {
        if (take) {
          take.playing = false;
          take.positionMs = take.durationMs;
        }
        if (caption) caption.until = now() + captionLingerMs(caption.line.text);
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
      const at = now();
      if (caption?.until !== null && caption && at >= caption.until) caption = null;
      const main = caption ? prepared.get(caption.line.take) : undefined;
      const positionMs = main
        ? Math.min(
            main.durationMs,
            main.positionMs + (main.playing ? Math.max(0, at - main.reportedAt) : 0),
          )
        : 0;
      const visible: VisibleCaption | null = caption
        ? {
            line: caption.line,
            source: caption.source,
            dissent: caption.dissent,
            ageMs: Math.max(0, at - caption.shownAt),
            positionMs,
            durationMs: main?.durationMs ?? 0,
            highlighted:
              caption.source === "started"
                ? highlightedWord(caption.line.text, positionMs, main?.durationMs ?? 0)
                : -1,
          }
        : null;
      const blocked =
        state.muted || state.heldBy.includes("muted") || state.heldBy.includes("killed");
      return {
        state,
        layout: resolveOverlayLayout(queryLayout, state.layout),
        channel,
        pose: blocked ? "muted" : held() ? "asleep" : pose,
        caption: blocked || held() ? null : visible,
        voices,
        messages,
        active,
        rms,
        audioChannel,
        newestName,
        raid: raid && at < raid.until ? { name: raid.name, viewers: raid.viewers } : null,
        particles: particleCues,
      };
    },
  };
}
export type ViewStore = ReturnType<typeof createViewStore>;
