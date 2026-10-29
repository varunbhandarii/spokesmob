import {
  type BeatState,
  type EventNotice,
  eventNoticeSchema,
  type QueuedEventLine,
} from "./beat-types.js";
import type { MoodSignals } from "./types.js";

export interface EventLineState {
  active: boolean;
  highestLevel: number;
  announcedLevels: readonly number[];
  lastLevelAt: number | null;
  lastAt: number;
}
export const createEventLineState = (): EventLineState => ({
  active: false,
  highestLevel: 0,
  announcedLevels: [],
  lastLevelAt: null,
  lastAt: Number.NEGATIVE_INFINITY,
});
export type MobEvent =
  | { kind: "raid"; id: string; at: number; name: string; viewers: number }
  | {
      kind: "hype";
      id: string;
      at: number;
      stage: "begin" | "progress" | "end";
      level: number;
      shared: boolean;
    };

export function formatEventLine(notice: EventNotice): string | null {
  const parsed = eventNoticeSchema.safeParse(notice);
  if (!parsed.success) return null;
  const item = parsed.data;
  if (item.kind === "raid") {
    const name = item.name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
    if (!name) return null;
    const viewers = item.viewers >= 10000 ? "over ten thousand" : String(item.viewers);
    return `Raiders from ${name} just joined the mob, ${viewers} new voices.`;
  }
  if (item.kind === "hype_end") return null;
  if (item.kind === "hype_begin")
    return `Hype train! The mob is on board${item.shared ? " with friends" : ""}.`;
  return `Hype train level ${item.level}${item.shared ? " with friends" : ""}!`;
}

export function reduceEventLine(
  state: EventLineState,
  event: MobEvent,
): {
  state: EventLineState;
  notice: EventNotice | null;
  candidate: QueuedEventLine | null;
} {
  if (!Number.isFinite(event.at) || event.at < 0) return { state, notice: null, candidate: null };
  if (event.kind === "raid") {
    const notice: EventNotice = {
      kind: "raid",
      name: event.name.replace(/_/g, " ").replace(/\s+/g, " ").trim(),
      viewers: event.viewers,
    };
    const text = formatEventLine(notice);
    return {
      state,
      notice: text ? notice : null,
      candidate: text ? { id: event.id, at: event.at, notice, text } : null,
    };
  }
  if (event.at < state.lastAt) return { state, notice: null, candidate: null };
  const notice: EventNotice = {
    kind:
      event.stage === "end" ? "hype_end" : event.stage === "begin" ? "hype_begin" : "hype_level",
    level: event.level,
    shared: event.shared,
  };
  if (!eventNoticeSchema.safeParse(notice).success) return { state, notice: null, candidate: null };
  if (event.stage === "end")
    return { state: { ...createEventLineState(), lastAt: event.at }, notice, candidate: null };
  let next: EventLineState =
    event.stage === "begin"
      ? {
          active: true,
          highestLevel: event.level,
          announcedLevels: [event.level],
          lastLevelAt: null,
          lastAt: event.at,
        }
      : {
          ...state,
          active: true,
          highestLevel: Math.max(state.highestLevel, event.level),
          lastAt: event.at,
        };
  let text = event.stage === "begin" ? formatEventLine(notice) : null;
  if (
    event.stage === "progress" &&
    event.level >= next.highestLevel &&
    !state.announcedLevels.includes(event.level) &&
    (state.lastLevelAt === null || event.at - state.lastLevelAt >= 20000)
  ) {
    text = formatEventLine(notice);
    next = {
      ...next,
      announcedLevels: [...state.announcedLevels, event.level],
      lastLevelAt: event.at,
    };
  }
  return {
    state: next,
    notice,
    candidate: text
      ? { id: event.id, at: event.at, notice: notice as QueuedEventLine["notice"], text }
      : null,
  };
}

export function beatMoodSignals(
  state: Pick<BeatState, "raidHypeUntil" | "hype">,
  now: number,
): Pick<MoodSignals, "raid_active" | "hype_level"> {
  return {
    raid_active: state.raidHypeUntil !== null && state.raidHypeUntil > now,
    hype_level: state.hype?.level ?? 0,
  };
}
