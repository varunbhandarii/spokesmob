import { type BeatSettingsPatch, resolveBeatSettings } from "./beat-settings.js";
import type {
  ActiveBeat,
  BeatEffect,
  BeatEvent,
  BeatGates,
  BeatLine,
  BeatLogStatus,
  BeatReduction,
  BeatState,
  BeatTimerKind,
  BeatVoice,
  HeldReason,
  Layout,
} from "./beat-types.js";

export function heldReasons(state: BeatState): HeldReason[] {
  const gate = state.gates;
  const reasons: HeldReason[] = [];
  if (!gate.enabled) reasons.push("off");
  if (state.muted) reasons.push("muted");
  if (gate.killed) reasons.push("killed");
  if (!gate.online && !gate.testOffline) reasons.push("offline");
  if (gate.capped) reasons.push("capped");
  if (state.settings.mode === "quiet") {
    if (!gate.overlayConnected) reasons.push("no_audio_client");
  } else if (!gate.audioConnected || !gate.overlayConnected) reasons.push("no_audio_client");
  else if (!gate.audioActive) reasons.push("overlay_inactive");
  return reasons;
}

export function createBeatState(
  options: {
    settings?: BeatSettingsPatch;
    gates?: Partial<BeatGates>;
    muted?: boolean;
    mutedUntil?: number | null;
    layout?: Layout;
  } = {},
): BeatState {
  const settings = resolveBeatSettings(options.settings);
  const state: BeatState = {
    voteOpen: false,
    step: "off",
    mode: settings.mode,
    settings,
    muted: options.muted ?? false,
    mutedUntil: options.mutedUntil ?? null,
    online: false,
    testOffline: false,
    capped: false,
    heldBy: [],
    question: null,
    layout: options.layout ?? "wide",
    mood: null,
    hype: null,
    gates: {
      enabled: false,
      killed: false,
      online: false,
      testOffline: false,
      capped: false,
      audioConnected: false,
      audioActive: false,
      overlayConnected: false,
      ...options.gates,
    },
    collection: null,
    current: null,
    queuedEvent: null,
    timers: {},
    cooldownUntil: null,
    previousLine: null,
    questionChanged: false,
    nextId: 1,
    lastMood: null,
    raidHypeUntil: null,
  };
  state.online = state.gates.online;
  state.testOffline = state.gates.testOffline;
  state.capped = state.gates.capped;
  state.heldBy = heldReasons(state);
  return state;
}

const voice = (): BeatVoice => ({ take: null, status: "pending" });
const isActive = (state: BeatState) =>
  state.step === "synthesizing" || state.step === "preview" || state.step === "speaking";

export function reduce(input: BeatState, event: BeatEvent, now: number): BeatReduction {
  if (!Number.isFinite(now) || now < 0)
    throw new RangeError("Beat time must be finite and nonnegative");
  const state: BeatState = {
    ...input,
    settings: { ...input.settings },
    gates: { ...input.gates },
    timers: { ...input.timers },
    collection: input.collection ? { ...input.collection } : null,
    current: input.current
      ? {
          ...input.current,
          main: { ...input.current.main },
          dissent: input.current.dissent ? { ...input.current.dissent } : null,
        }
      : null,
  };
  const effects: BeatEffect[] = [];
  let changed = false;
  const mark = () => {
    changed = true;
  };
  const id = () => state.nextId++;
  const dropTimer = (kind: BeatTimerKind) => {
    delete (state.timers as Partial<Record<BeatTimerKind, unknown>>)[kind];
  };
  const timer = (kind: BeatTimerKind, at: number) => {
    const value = { id: id(), kind, at };
    state.timers = { ...state.timers, [kind]: value };
    effects.push({ type: "setTimer", timer: value });
  };
  const refresh = () => {
    state.mode = state.settings.mode;
    state.online = state.gates.online;
    state.testOffline = state.gates.testOffline;
    state.capped = state.gates.capped;
    state.heldBy = heldReasons(state);
    state.mood =
      state.hype || (state.raidHypeUntil !== null && state.raidHypeUntil > now)
        ? "hype"
        : state.lastMood;
  };
  const log = (status: BeatLogStatus, gate: string | null, reason: string | null) => {
    if (state.current)
      effects.push({ type: "log", beat: state.current, at: now, status, gate, reason });
  };
  const cancel = (reason: string, status: BeatLogStatus) => {
    state.voteOpen = false;
    effects.push({ type: "abortSynthesis", beatId: state.current?.id ?? null });
    effects.push({ type: "cancelVoice", beatId: state.current?.id ?? null, reason });
    log(status, "control", reason);
    state.current = null;
    state.cooldownUntil = null;
    for (const kind of ["hold", "reading", "cooldown"] as const) dropTimer(kind);
  };
  const armWindow = () => {
    if (state.voteOpen || !state.collection || state.timers.window) return;
    const start = state.collection.startAt;
    timer(
      "window",
      now < start + state.settings.windowS * 1000
        ? start + state.settings.windowS * 1000
        : now < start + 30000
          ? start + 30000
          : now + 500,
    );
  };
  const open = () => {
    if (state.collection) return;
    state.collection = { id: id(), startAt: now, voices: 0, messages: 0 };
    effects.push({ type: "openWindow", window: state.collection });
    armWindow();
  };
  const cooldown = () => {
    state.current = null;
    dropTimer("hold");
    dropTimer("reading");
    state.step = "cooldown";
    state.cooldownUntil = now + state.settings.cooldownS * 1000;
    timer("cooldown", state.cooldownUntil);
  };
  const settle = () => {
    const beat = state.current;
    if (!beat) return;
    log(beat.outcome ?? "caption_only", beat.reason ? "voice" : null, beat.reason);
    if (beat.outcome === "spoken" || state.mode === "quiet")
      state.previousLine = beat.line?.text ?? state.previousLine;
    cooldown();
  };
  const unitEnded = (status: "spoken" | "caption_only", allowPost: boolean) => {
    const beat = state.current;
    if (beat?.output !== "idle") return;
    beat.outcome = status;
    if (beat.line)
      effects.push({ type: "shown", beatId: beat.id, line: beat.line, status, at: now });
    if (beat.purpose === "split") {
      state.voteOpen = true;
      dropTimer("window");
      effects.push({ type: "openVote", beatId: beat.id });
      settle();
      return;
    }
    if (
      allowPost &&
      beat.kind === "consensus" &&
      state.settings.postLines === "every" &&
      beat.line
    ) {
      beat.output = "sending";
      effects.push({ type: "post", beatId: beat.id, line: beat.line });
    } else settle();
  };
  const startPlay = (channel: "main" | "dissent") => {
    const beat = state.current;
    const take = beat?.[channel];
    if (!beat || !take || take.status !== "ready") return;
    take.status = "playing";
    state.step = "speaking";
    effects.push({ type: "play", beatId: beat.id, channel });
  };
  const afterMain = () => {
    const beat = state.current;
    if (beat?.main.status !== "ended") return;
    if (!beat.dissent || beat.dissent.status === "caption_only" || beat.dissent.status === "ended")
      unitEnded("spoken", true);
    else if (beat.dissent.status === "ready") startPlay("dissent");
  };
  const holdEnded = () => {
    const beat = state.current;
    if (!beat || state.step !== "preview" || now < (beat.holdUntil ?? Infinity)) return;
    if (state.mode === "quiet") {
      effects.push({ type: "reveal", beatId: beat.id, fresh: false });
      state.step = "speaking";
    } else if (beat.main.status === "caption_only") {
      effects.push({ type: "cancelVoice", beatId: beat.id, reason: "caption_only" });
      effects.push({ type: "reveal", beatId: beat.id, fresh: true });
      state.step = "speaking";
      timer("reading", now + Math.max(2500, (beat.line?.text.length ?? 0) * 55));
    } else startPlay("main");
  };
  const preview = (line: BeatLine) => {
    const beat = state.current;
    if (!beat) return;
    beat.line = {
      ...line,
      citedNames: line.citedNames.slice(0, 40).map((name) => name.slice(0, 50)),
    };
    beat.dissent = line.dissent ? voice() : null;
    beat.holdUntil = now + state.settings.holdMs;
    state.lastMood = line.mood;
    state.step = "preview";
    effects.push({
      type: "preview",
      beatId: beat.id,
      line: beat.line,
      holdMs: state.settings.holdMs,
      quiet: state.mode === "quiet",
    });
    if (state.mode === "quiet") {
      timer("hold", beat.holdUntil);
      timer("reading", beat.holdUntil + 3000);
    } else {
      effects.push({ type: "prepareVoice", beatId: beat.id, line: beat.line });
      timer("hold", beat.holdUntil);
    }
  };
  const activeBeat = (kind: "consensus" | "event", windowId: number | null): ActiveBeat => ({
    id: id(),
    kind,
    windowId,
    closedAt: now,
    line: null,
    main: voice(),
    dissent: null,
    holdUntil: null,
    mainEndedAt: null,
    output: "idle",
    outcome: null,
    reason: null,
    question: state.question,
  });
  const eligible = (speak = false) => {
    if (state.voteOpen || state.step !== "listening" || state.heldBy.length || !state.collection)
      return;
    if (state.queuedEvent) {
      const queued = state.queuedEvent;
      state.queuedEvent = null;
      state.current = activeBeat("event", null);
      state.step = "synthesizing";
      effects.push({ type: "verifyEvent", beatId: state.current.id, event: queued });
      return;
    }
    if (
      state.mode === "demand"
        ? !speak
        : speak || now < state.collection.startAt + state.settings.windowS * 1000
    )
      return;
    if (state.collection.voices < state.settings.minVoices) return;
    const previous = state.collection;
    state.collection = { id: id(), startAt: now, voices: 0, messages: 0 };
    effects.push({
      type: "closeWindow",
      windowId: previous.id,
      nextWindow: state.collection,
      at: now,
    });
    dropTimer("window");
    armWindow();
    state.current = activeBeat("consensus", previous.id);
    state.step = "synthesizing";
    effects.push({
      type: "synthesize",
      beatId: state.current.id,
      windowId: previous.id,
      question: state.question,
      questionChanged: state.questionChanged,
      previousLine: state.previousLine,
    });
    state.questionChanged = false;
  };
  const enforce = () => {
    refresh();
    if (!state.gates.enabled) {
      state.step = "off";
      return;
    }
    open();
    if (state.heldBy.length) {
      if (isActive(state)) cancel(state.heldBy.join(","), "blocked");
      if (state.step === "cooldown") {
        state.cooldownUntil = null;
        dropTimer("cooldown");
      }
      state.step = "held";
    } else if (state.step === "held" || state.step === "off") {
      state.step = "listening";
      eligible();
    }
  };
  const notice = (value: Extract<BeatEvent, { type: "notice" }>["notice"]) => {
    if (value.kind === "raid") {
      state.raidHypeUntil = now + 30000;
      timer("mood", state.raidHypeUntil);
    } else if (value.kind === "hype_end") state.hype = null;
    else state.hype = { level: value.level, shared: value.shared };
  };

  refresh();
  switch (event.type) {
    case "off": {
      mark();
      cancel("off", "skipped");
      state.gates.enabled = false;
      state.queuedEvent = null;
      if (state.collection)
        effects.push({
          type: "closeWindow",
          windowId: state.collection.id,
          nextWindow: null,
          at: now,
        });
      state.collection = null;
      dropTimer("window");
      state.step = "off";
      break;
    }
    case "on": {
      if (state.gates.enabled && state.step !== "off") break;
      mark();
      state.gates.enabled = true;
      if (state.muted && state.mutedUntil !== null) timer("mute", Math.max(now, state.mutedUntil));
      enforce();
      break;
    }
    case "mute":
    case "kill": {
      if (event.type === "mute" && state.gates.killed) break;
      if (event.type === "kill" && state.muted && state.gates.killed && state.mutedUntil === null)
        break;
      mark();
      cancel(event.type, "muted");
      state.queuedEvent = null;
      state.muted = true;
      state.gates.killed = event.type === "kill";
      state.mutedUntil =
        event.type === "mute" ? now + Math.min(60, Math.max(1, event.minutes)) * 60000 : null;
      dropTimer("mute");
      if (state.mutedUntil !== null) timer("mute", state.mutedUntil);
      effects.push(
        { type: "unpin" },
        { type: "ack", text: "Spokesmob muted" },
        {
          type: "persistSafety",
          muted: true,
          mutedUntil: state.mutedUntil,
          killed: state.gates.killed,
        },
      );
      enforce();
      break;
    }
    case "unmute": {
      if (!state.muted && !state.gates.killed) break;
      mark();
      state.muted = false;
      state.mutedUntil = null;
      state.gates.killed = false;
      dropTimer("mute");
      effects.push(
        { type: "persistSafety", muted: false, mutedUntil: null, killed: false },
        { type: "ack", text: "Spokesmob unmuted" },
      );
      enforce();
      break;
    }
    case "gate": {
      if (
        !Object.entries(event.changes).some(
          ([key, value]) => state.gates[key as keyof BeatGates] !== value,
        )
      )
        break;
      mark();
      state.gates = { ...state.gates, ...event.changes };
      if (event.changes.online === false) state.voteOpen = false;
      if (!state.gates.enabled) {
        const stopped = reduce(state, { type: "off" }, now);
        return stopped;
      }
      enforce();
      break;
    }
    case "windowReady": {
      if (state.collection?.id !== event.windowId) break;
      mark();
      state.collection.voices = event.voices;
      state.collection.messages = event.messages;
      eligible();
      break;
    }
    case "tick": {
      const pending = state.timers[event.timer];
      if (!pending || pending.id !== event.id) break;
      if (now < pending.at)
        return { state: input, effects: [{ type: "setTimer", timer: pending }] };
      mark();
      dropTimer(event.timer);
      if (event.timer === "window") {
        eligible();
        if (state.collection && now - state.collection.startAt >= 30000) {
          state.collection.startAt = now - 30000;
          effects.push({
            type: "slideWindow",
            windowId: state.collection.id,
            startAt: state.collection.startAt,
          });
        }
        armWindow();
      } else if (event.timer === "hold") holdEnded();
      else if (
        event.timer === "reading" &&
        state.step === "speaking" &&
        (state.mode === "quiet" || state.current?.main.status === "caption_only")
      )
        unitEnded("caption_only", state.mode === "quiet");
      else if (event.timer === "cooldown" && state.step === "cooldown") {
        state.cooldownUntil = null;
        state.step = "listening";
        eligible();
      } else if (event.timer === "mute") {
        state.muted = false;
        state.mutedUntil = null;
        state.gates.killed = false;
        effects.push({ type: "persistSafety", muted: false, mutedUntil: null, killed: false });
        enforce();
      } else if (event.timer === "mood") state.raidHypeUntil = null;
      break;
    }
    case "speak": {
      if (state.mode !== "demand" || state.step !== "listening" || state.heldBy.length) break;
      mark();
      eligible(true);
      break;
    }
    case "manualVote": {
      if (
        state.step !== "listening" ||
        state.voteOpen ||
        state.heldBy.length ||
        !state.gates.enabled
      )
        break;
      mark();
      state.current = activeBeat("consensus", null);
      state.current.purpose = "split";
      preview(event.line);
      break;
    }
    case "voteFinished": {
      if (!state.voteOpen) break;
      state.voteOpen = false;
      mark();
      if (event.line && !state.heldBy.length && state.gates.enabled) {
        dropTimer("cooldown");
        state.current = activeBeat("consensus", null);
        state.current.purpose = "vote_result";
        preview(event.line);
      }
      armWindow();
      break;
    }
    case "synthDone": {
      if (
        state.step !== "synthesizing" ||
        state.current?.id !== event.beatId ||
        state.current.kind !== "consensus"
      )
        break;
      mark();
      const result = event.result;
      if (result.templateKind) state.current.purpose = result.templateKind;
      if (result.status !== "verified" || !result.line || !result.mood) {
        log("suppressed", result.gate, result.reason ?? "invalid_result");
        cooldown();
      } else
        preview({
          text: result.line,
          dissent: result.dissent,
          dissentPct: result.dissentPct,
          pct: result.pct,
          voices: result.voices,
          mood: result.mood,
          question: state.question,
          answersQuestion: result.answersQuestion && state.current.question === state.question,
          templated: !!result.templateKind,
          showAgreement: !result.templateKind,
          citedNames: result.citedNames,
          citedExemplars: event.citedExemplars,
          raidName: null,
        });
      break;
    }
    case "eventVerified": {
      if (
        state.step !== "synthesizing" ||
        state.current?.id !== event.beatId ||
        state.current.kind !== "event"
      )
        break;
      mark();
      if (event.line?.templated) preview(event.line);
      else {
        log("suppressed", "verification", event.reason ?? "invalid_event");
        cooldown();
      }
      break;
    }
    case "voiceReady": {
      const beat = state.current;
      const take = beat?.[event.channel];
      if (
        !beat ||
        beat.id !== event.beatId ||
        !take ||
        take.status !== "pending" ||
        state.mode === "quiet"
      )
        break;
      mark();
      take.take = event.take;
      take.status = "ready";
      if (event.channel === "main") holdEnded();
      else afterMain();
      break;
    }
    case "voiceStarted": {
      // The shell records the actual started timestamp; play was already authorized here.
      break;
    }
    case "voiceEnded": {
      const beat = state.current;
      const take = beat?.[event.channel];
      if (
        !beat ||
        beat.id !== event.beatId ||
        state.step !== "speaking" ||
        !take ||
        take.take !== event.take ||
        take.status !== "playing"
      )
        break;
      mark();
      take.status = "ended";
      if (event.channel === "main") {
        beat.mainEndedAt = now;
        afterMain();
      } else unitEnded("spoken", true);
      break;
    }
    case "captionOnly": {
      const beat = state.current;
      const take = beat?.[event.channel];
      if (
        !beat ||
        beat.id !== event.beatId ||
        !take ||
        take.status === "ended" ||
        take.status === "caption_only" ||
        take.status === "cancelled" ||
        beat.output !== "idle" ||
        state.mode === "quiet"
      )
        break;
      mark();
      take.status = "caption_only";
      if (event.channel === "main") {
        beat.reason = event.reason;
        if (state.step === "speaking") {
          effects.push({ type: "cancelVoice", beatId: beat.id, reason: "caption_only" });
          unitEnded("caption_only", false);
        } else holdEnded();
      } else afterMain();
      break;
    }
    case "veto": {
      if (
        state.current?.output !== "idle" ||
        (state.step !== "preview" && state.step !== "speaking")
      )
        break;
      mark();
      effects.push({ type: "emit", name: "veto", beatId: state.current.id });
      cancel("veto", "vetoed");
      cooldown();
      break;
    }
    case "invalidate": {
      if (
        !state.current ||
        !isActive(state) ||
        (state.current.output !== "idle" && state.current.purpose !== "vote_result")
      )
        break;
      mark();
      cancel(event.reason, "blocked");
      cooldown();
      break;
    }
    case "event": {
      if (!state.gates.enabled || state.heldBy.length) break;
      mark();
      notice(event.event.notice);
      const queued = state.queuedEvent;
      if (
        !queued ||
        (event.event.notice.kind === "raid" && queued.notice.kind !== "raid") ||
        ((queued.notice.kind !== "raid" || event.event.notice.kind === "raid") &&
          event.event.at >= queued.at)
      )
        state.queuedEvent = event.event;
      eligible();
      break;
    }
    case "notice": {
      mark();
      notice(event.notice);
      break;
    }
    case "settings": {
      mark();
      const previousMode = state.settings.mode;
      state.settings = resolveBeatSettings(state.settings, event.changes);
      if (previousMode !== state.settings.mode && isActive(state)) {
        cancel("mode_changed", "blocked");
        state.step = "listening";
      }
      dropTimer("window");
      armWindow();
      enforce();
      eligible();
      break;
    }
    case "question": {
      if (state.question === event.question) break;
      mark();
      state.question = event.question;
      state.voteOpen = false;
      state.questionChanged = true;
      if (event.question) effects.push({ type: "announce", question: event.question });
      break;
    }
    case "layout": {
      if (state.layout !== event.layout) {
        mark();
        state.layout = event.layout;
      }
      break;
    }
    case "postDone": {
      const beat = state.current;
      if (!beat || beat.id !== event.beatId || beat.output !== "sending") break;
      mark();
      if (event.sent && event.messageId && !event.dropReason && !state.heldBy.length) {
        beat.output = "pinning";
        effects.push({
          type: "pin",
          beatId: beat.id,
          messageId: event.messageId,
          durationS: state.settings.pinS,
        });
      } else settle();
      break;
    }
    case "pinDone": {
      if (!state.current || state.current.id !== event.beatId || state.current.output !== "pinning")
        break;
      mark();
      settle();
      break;
    }
  }
  refresh();
  if (!changed) return { state: input, effects: [] };
  effects.push({ type: "emit", name: "state", beatId: state.current?.id ?? null });
  return { state, effects };
}
