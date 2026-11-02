import type { Logger } from "pino";
import { createBeatState, reduce } from "../../../../packages/core/src/beat.js";
import {
  type BeatSettings,
  resolveBeatSettings,
} from "../../../../packages/core/src/beat-settings.js";
import {
  type BeatEffect,
  type BeatEvent,
  type BeatLine,
  type BeatState,
  type BeatView,
  beatViewSchema,
} from "../../../../packages/core/src/beat-types.js";
import type { Blocklist } from "../../../../packages/core/src/blocklist.js";
import type { ChatVote, VoteChoices } from "../../../../packages/core/src/chat-vote.js";
import { voteMinimum } from "../../../../packages/core/src/chat-vote.js";
import { modelCost } from "../../../../packages/core/src/cost.js";
import {
  beatMoodSignals,
  createEventLineState,
  reduceEventLine,
} from "../../../../packages/core/src/event-lines.js";
import { LaughDetector } from "../../../../packages/core/src/laugh.js";
import { fromTwitchChat } from "../../../../packages/core/src/normalize.js";
import type {
  ControlMessage,
  OverlayMessage,
} from "../../../../packages/core/src/overlay-protocol.js";
import { RecentChat } from "../../../../packages/core/src/recent-chat.js";
import { verifyTemplated } from "../../../../packages/core/src/verify.js";
import { assembleWindow } from "../../../../packages/core/src/window.js";
import { atDeadline, type Clock, systemClock } from "../clock.js";
import { type CollectorSnapshot, ConsensusCollector } from "../consensus/collector.js";
import { fakeModelResult } from "../consensus/fakes.js";
import { ModerationGate } from "../consensus/moderation.js";
import type { ConsensusModelPort, ModerationPort } from "../consensus/ports.js";
import { synthesize } from "../consensus/synthesize.js";
import type { Repositories } from "../store/repositories.js";
import type { SpendLedger } from "../store/spend.js";
import type { TwitchBus } from "../twitch/bus.js";
import type { TwitchEvent } from "../twitch/events.js";
import type { StreamStatus } from "../twitch/online.js";
import type { PlaybackReport, VoiceManager, VoiceTake } from "../voice/manager.js";
import type { VoiceUsage } from "../voice/types.js";
import type { ClipCapture } from "./clips.js";
import type { ChatOutput } from "./output.js";
import { BeatRecords } from "./records.js";
import { SplitVotes } from "./votes.js";

export interface BeatRunnerOptions {
  bus: TwitchBus;
  online: Pick<StreamStatus, "snapshot" | "onChange">;
  store: Repositories;
  ledger: SpendLedger;
  settings: BeatSettings;
  sessionId: string;
  voice: Pick<VoiceManager, "prepare" | "cancelAll" | "nextTakeId">;
  output: ChatOutput;
  model: ConsensusModelPort;
  moderation: ModerationPort;
  blocklist: Blocklist;
  clients(): { audioConnected: boolean; audioActive: boolean; overlayConnected: boolean };
  overlay(message: OverlayMessage): void;
  control?(message: ControlMessage): void;
  log: Pick<Logger, "info" | "warn">;
  clock?: Clock;
  seed?: number;
  tier?: "default" | "fast";
  paidModel: boolean;
  paidVoice: boolean;
  simulated?: boolean;
  channelName?: string;
  clips?: Pick<ClipCapture, "capture" | "stop">;
  apiFailure?(source: "model" | "voice"): void;
}
export class BeatRunner {
  state: BeatState;
  private readonly votes: SplitVotes;
  private readonly voteProposals = new Map<number, { choices: VoteChoices; manual: boolean }>();
  private readonly activity = new RecentChat();
  private manualPending = false;
  private manualController: AbortController | null = null;
  private readonly laughs = new LaughDetector();
  private readonly shownEnds = new Map<number, number>();
  private readonly clock: Clock;
  private readonly collector: ConsensusCollector;
  private readonly moderation: ModerationGate;
  private questionGeneration = 0;
  private readonly snapshotQuestions = new Map<number, number>();
  private preparingBeatId: number | null = null;
  private readonly snapshots = new Map<number, CollectorSnapshot>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly takes = new Map<number, { main?: VoiceTake; dissent?: VoiceTake }>();
  private readonly visualTakes = new Map<number, number>();
  private readonly takeBeats = new Map<number, number>();
  private readonly tickets = new Map<string, string>();
  private readonly timers = new Map<string, () => void>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly events: BeatEvent[] = [];
  private readonly cleanup: (() => void)[] = [];
  private readonly stateListeners = new Set<(state: BeatView) => void>();
  private draining = false;
  private stopped = false;
  private started = false;
  private sawOffline: boolean;
  private liveSessions = 0;
  private eventLines = createEventLineState();
  private particleNames: string[] = [];
  private intervals: ReturnType<typeof setInterval>[] = [];
  readonly records: BeatRecords;
  readonly processingMs: number[] = [];
  readonly collectionMs: number[] = [];
  private closedBeats = 0;
  get pendingBeats() {
    return this.records.books.size
      ? [...this.records.books.values()].filter((book) => !book.status).length
      : 0;
  }
  get resolvedBeats() {
    return this.closedBeats;
  }

  constructor(private readonly options: BeatRunnerOptions) {
    this.clock = options.clock ?? systemClock;
    const safety = options.store.settings.getSafety();
    const online = options.online.snapshot();
    this.sawOffline = online.known && !online.online;
    const settings = resolveBeatSettings(options.settings, options.store.settings.get());
    options.ledger.setCap(settings.spendCapUsd);
    this.state = createBeatState({
      settings,
      muted: safety.muted,
      mutedUntil: safety.mutedUntil,
      layout: options.store.settings.getLayout(),
      gates: {
        ...options.clients(),
        killed: safety.killed,
        online: online.known && online.online,
        capped: options.ledger.totals().total >= settings.spendCapUsd,
      },
    });
    this.moderation = new ModerationGate({ port: options.moderation, clock: this.clock });
    this.votes = new SplitVotes({
      enabled: () => this.state.settings.splitVotes,
      resultMinimum: () =>
        voteMinimum(this.state.settings.minVoices, this.activity.distinct(this.clock.now())),
      onBallot: (event) => this.activity.observe(fromTwitchChat(event)),
      gagged: (id) => this.options.store.gags.list().includes(id),
      blocklist: options.blocklist,
      moderation: this.moderation,
      safeTemplate: (text, signal) => this.verifyTemplate(text, signal),
      overlay: options.overlay,
      control: (message) => options.control?.(message),
      announce: (text, admission) => options.output.announceVote(text, admission),
      finish: (result) => this.finishVote(result),
      clock: this.clock,
    });
    this.collector = new ConsensusCollector({
      acceptChat: (event) => this.votes.acceptsChat(event),
      bus: options.bus,
      moderation: this.moderation,
      blocklist: options.blocklist,
      clock: this.clock,
      seed: options.seed ?? 17,
      log: options.log,
      windowOptions: () => ({ gaggedUsers: new Set(options.store.gags.list()) }),
      onProcessing: (ms) => this.trackProcessing(ms),
    });
    this.records = new BeatRecords(
      options.store,
      options.sessionId,
      (row) => options.control?.({ type: "log", row }),
      (names) => this.safeNames(names),
      options.simulated ?? false,
    );
  }
  view(): BeatView {
    const state = this.state;
    return beatViewSchema.parse({
      step: state.step,
      mode: state.mode,
      muted: state.muted,
      mutedUntil: state.mutedUntil,
      online: state.online,
      testOffline: state.testOffline,
      capped: state.capped,
      heldBy: state.heldBy,
      question: state.question,
      layout: state.layout,
      mood: state.mood,
      hype: state.hype,
    });
  }
  onState(listener: (view: BeatView) => void) {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.cleanup.push(
      this.options.bus.onEvent((event) => this.receive(event)),
      this.options.online.onChange((value) =>
        this.dispatch({ type: "gate", changes: { online: value.known && value.online } }),
      ),
    );
    this.intervals = [
      this.clock.setInterval(() => this.sampleWindow(), 500),
      this.clock.setInterval(() => this.flushParticles(), 250),
    ];
    const online = this.options.online.snapshot();
    this.dispatch({
      type: "gate",
      changes: { ...this.options.clients(), online: online.known && online.online },
    });
    this.dispatch({ type: "on" });
  }
  dispatch(event: BeatEvent) {
    if (this.stopped) return;
    if (
      ["off", "mute", "kill", "question"].includes(event.type) ||
      (event.type === "gate" &&
        (event.changes.online === false ||
          event.changes.capped === true ||
          event.changes.audioActive === false ||
          event.changes.audioConnected === false))
    )
      this.manualController?.abort();
    if (
      ["mute", "kill", "off", "veto", "invalidate"].includes(event.type) ||
      (event.type === "gate" && event.changes.online === false)
    )
      this.laughs.cancel();
    if (event.type === "question") {
      this.questionGeneration++;
      this.votes.questionChanged();
      if (this.state.current?.purpose === "split" || this.state.current?.purpose === "vote_result")
        this.dispatch({ type: "invalidate", reason: "question_changed" });
    } else if (
      ["mute", "kill", "off"].includes(event.type) ||
      (event.type === "gate" &&
        (event.changes.online === false || event.changes.capped === true)) ||
      (event.type === "settings" && event.changes.splitVotes === false)
    )
      this.votes.cancel(event.type);
    this.events.push(event);
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.events.length) {
        const next = this.events.shift();
        if (!next) break;
        const result = reduce(this.state, next, this.clock.now());
        this.state = result.state;
        for (const effect of result.effects) this.effect(effect);
      }
    } finally {
      this.draining = false;
    }
  }
  refreshClients() {
    this.dispatch({ type: "gate", changes: this.options.clients() });
  }
  invalidateGag(userId: string) {
    this.votes.removeAuthor(userId, this.clock.now(), true);
    this.activity.removeAuthor(userId);
    this.particleNames = [];
    this.options.overlay({ type: "particles_clear" });
    const source = this.state.current
      ? this.records.books.get(this.state.current.id)?.snapshot?.messages
      : undefined;
    if (source?.some((message) => message.authorId === userId))
      this.dispatch({ type: "invalidate", reason: "gagged_user" });
    this.sampleWindow();
  }
  publishCost() {
    const total = this.options.ledger.totals();
    this.options.control?.({
      type: "cost",
      usdSession: total.total,
      usdHour: this.options.store.costLedger.hourly(this.clock.now()).budgetUsd,
      cap: total.cap,
    });
  }
  refreshBudget() {
    const total = this.options.ledger.totals();
    const next =
      (this.options.paidModel ? 0.0005 : 0) +
      (this.state.mode !== "quiet" && this.options.paidVoice ? 0.0085 : 0);
    this.dispatch({
      type: "gate",
      changes: { capped: total.total >= total.cap || !this.options.ledger.canReserve(next) },
    });
    this.publishCost();
  }
  private allowed(): boolean {
    return !this.stopped && this.state.heldBy.length === 0 && this.state.gates.enabled;
  }
  private safeNames(names: readonly string[]): string[] {
    return names
      .filter((name) => !!name.trim() && !this.options.blocklist.check(name).blocked)
      .slice(0, 40)
      .map((name) => name.slice(0, 50));
  }
  private task(work: () => Promise<void>, name: string) {
    const promise = work().catch(() =>
      this.options.log.warn({ effect: name }, "Beat effect failed"),
    );
    this.tasks.add(promise);
    void promise.finally(() => this.tasks.delete(promise));
  }
  private current(id: number) {
    return this.allowed() && this.state.current?.id === id;
  }
  private capture(result: { text: string } | null) {
    if (result && this.options.clips)
      this.task(() => this.options.clips?.capture(result.text) ?? Promise.resolve(), "capture");
  }
  private sampleWindow() {
    this.capture(
      this.laughs.check(
        this.clock.now(),
        this.state.settings.autoClip,
        this.state.gates.online,
        this.activity.distinct(this.clock.now()),
      ),
    );
    if (!this.state.collection) return;
    const started = performance.now();
    const snapshot = this.collector.snapshot();
    const window = assembleWindow(snapshot.messages, snapshot.windowOptions);
    this.collectionMs.push(performance.now() - started);
    if (this.collectionMs.length > 6000) this.collectionMs.shift();
    this.dispatch({
      type: "windowReady",
      windowId: this.state.collection.id,
      voices: window.voices,
      messages: window.moodMessages.length,
    });
    if (this.state.step === "listening")
      this.options.overlay({
        type: "listening",
        voices: window.voices,
        messages: window.moodMessages.length,
        windowMs: Math.min(
          30000,
          Math.max(0, this.clock.now() - (this.state.collection?.startAt ?? this.clock.now())),
        ),
      });
  }
  private trackProcessing(ms: number) {
    this.processingMs.push(ms);
    if (this.processingMs.length > 6000) this.processingMs.shift();
  }
  private flushParticles() {
    if (!this.particleNames.length || !this.state.collection) return;
    this.options.overlay({ type: "particles", names: this.particleNames.splice(0, 200) });
    this.particleNames = [];
  }
  private receive(event: TwitchEvent) {
    if (event.kind === "stream") {
      const status = this.options.online.snapshot();
      if (status.known && status.online === event.online) {
        if (!event.online) this.sawOffline = true;
        else if (this.sawOffline) {
          this.sawOffline = false;
          this.options.ledger.reset(`${this.options.sessionId}:live:${++this.liveSessions}`);
          this.refreshBudget();
        }
      }
    } else if (event.kind === "chat") {
      if (this.votes.isBallot(event.text)) return;
      if (
        !event.self &&
        !event.text.trimStart().startsWith("!") &&
        !this.options.store.gags.list().includes(event.author.id)
      )
        this.activity.observe(fromTwitchChat(event));
      if (
        !event.self &&
        !event.text.trimStart().startsWith("!") &&
        !this.options.store.gags.list().includes(event.author.id)
      ) {
        const capture = this.laughs.observe(
          event.author.id,
          event.fragments,
          this.clock.now(),
          this.state.settings.autoClip,
          this.state.gates.online,
          this.activity.distinct(this.clock.now()),
        );
        this.capture(capture);
      }
      if (
        !this.state.collection ||
        event.self ||
        event.text.trimStart().startsWith("!") ||
        this.options.store.gags.list().includes(event.author.id)
      )
        return;
      if (!this.options.blocklist.check(event.author.name).blocked && event.author.name.trim())
        this.particleNames.push(event.author.name.slice(0, 50));
      if (this.particleNames.length > 200) this.particleNames = this.particleNames.slice(-200);
    } else if (
      event.kind === "chatDelete" ||
      event.kind === "chatClearUser" ||
      event.kind === "chatClear"
    ) {
      if (event.kind === "chatClear") {
        this.votes.cancel("chat cleared");
        this.activity.clear();
      } else if (event.kind === "chatClearUser") {
        this.votes.removeAuthor(event.userId, Date.parse(event.at));
        this.activity.removeAuthor(event.userId);
      } else {
        this.votes.removeMessage(event.messageId);
        this.activity.removeMessage(event.messageId);
      }
      this.particleNames = [];
      this.options.overlay({ type: "particles_clear" });
      const source = this.state.current
        ? this.records.books.get(this.state.current.id)?.snapshot?.messages
        : undefined;
      const affected =
        event.kind === "chatClear" ||
        source?.some((message) =>
          event.kind === "chatDelete"
            ? message.id === event.messageId
            : message.authorId === event.userId,
        );
      if (affected) this.dispatch({ type: "invalidate", reason: "moderator_action" });
    } else if (event.kind === "raid" || event.kind === "hype") {
      const result = reduceEventLine(
        this.eventLines,
        event.kind === "raid"
          ? {
              kind: "raid",
              id: `raid:${event.at}:${event.fromId}`,
              at: Date.parse(event.at),
              name: event.fromName,
              viewers: event.viewers,
            }
          : {
              kind: "hype",
              id: `hype:${event.at}:${event.stage}:${event.level}`,
              at: Date.parse(event.at),
              stage: event.stage,
              level: event.level,
              shared: event.shared,
            },
      );
      this.eventLines = result.state;
      if (result.notice) this.dispatch({ type: "notice", notice: result.notice });
      if (result.candidate) this.dispatch({ type: "event", event: result.candidate });
      if (result.notice?.kind === "hype_end")
        this.options.overlay({ type: "event", ...result.notice });
    }
  }
  private effect(effect: BeatEffect) {
    switch (effect.type) {
      case "shown":
        if (effect.status === "caption_only" || this.shownEnds.has(effect.beatId))
          this.laughs.shown(this.records.key(effect.beatId), effect.line.text, effect.at);
        break;
      case "openVote": {
        const choices = this.voteProposals.get(effect.beatId);
        if (choices) this.votes.open(choices.choices, choices.manual);
        else this.dispatch({ type: "voteFinished", line: null });
        break;
      }
      case "openWindow":
        this.collector.open(effect.window.startAt);
        break;
      case "closeWindow": {
        if (effect.nextWindow) {
          this.snapshots.set(effect.windowId, this.collector.roll(effect.at));
          this.snapshotQuestions.set(effect.windowId, this.questionGeneration);
        } else this.collector.close();
        break;
      }
      case "slideWindow":
        this.collector.slide(effect.startAt);
        break;
      case "setTimer": {
        const previous = this.timers.get(effect.timer.kind);
        previous?.();
        const cancel = atDeadline(this.clock, effect.timer.at, () => {
          if (this.timers.get(effect.timer.kind) !== cancel) return;
          this.timers.delete(effect.timer.kind);
          if (this.stopped || this.state.timers[effect.timer.kind]?.id !== effect.timer.id) return;
          this.dispatch({ type: "tick", timer: effect.timer.kind, id: effect.timer.id });
        });
        this.timers.set(effect.timer.kind, cancel);
        break;
      }
      case "synthesize":
        this.task(() => this.resolveConsensus(effect), "synthesize");
        break;
      case "verifyEvent":
        this.task(async () => {
          const beat = this.state.current;
          if (!beat || !this.current(effect.beatId)) return;
          this.records.begin(beat, this.state.mode);
          const name = effect.event.notice.kind === "raid" ? effect.event.notice.name : null;
          let line: BeatLine | null = null;
          if (
            (!name || !this.options.blocklist.check(name).blocked) &&
            (await this.verifyTemplate(effect.event.text))
          ) {
            line = {
              text: effect.event.text,
              dissent: null,
              dissentPct: null,
              pct: 0,
              voices: 0,
              mood: "hype",
              question: this.state.question,
              answersQuestion: false,
              templated: true,
              citedNames: [],
              citedExemplars: [],
              raidName: name,
            };
            if (this.current(effect.beatId))
              this.options.overlay({ type: "event", ...effect.event.notice });
          }
          this.dispatch({
            type: "eventVerified",
            beatId: effect.beatId,
            line,
            reason: line ? null : "output_moderation",
          });
        }, "verifyEvent");
        break;
      case "abortSynthesis": {
        if (effect.beatId === null)
          for (const controller of this.controllers.values()) controller.abort();
        else this.controllers.get(effect.beatId)?.abort();
        break;
      }
      case "preview": {
        const beat = this.state.current;
        if (!beat) break;
        const book = this.records.begin(beat, this.state.mode);
        book.line = effect.line;
        book.previewAt = this.clock.now();
        if (effect.quiet) {
          const take = this.options.voice.nextTakeId();
          this.visualTakes.set(effect.beatId, take);
          this.options.control?.({
            type: "preview",
            take,
            text: effect.line.text,
            dissent: effect.line.dissent,
            dissentPct: effect.line.dissentPct,
            pct: effect.line.pct,
            voices: effect.line.voices,
            holdMs: effect.holdMs,
            quiet: true,
          });
          this.options.overlay({
            type: "line",
            text: effect.line.text,
            pct: effect.line.pct,
            voices: effect.line.voices,
            dissent: effect.line.dissent,
            dissentPct: effect.line.dissentPct,
            mood: effect.line.mood,
            question: effect.line.question,
            answersQuestion: effect.line.answersQuestion,
            templated: effect.line.templated,
            showAgreement: effect.line.showAgreement ?? true,
            take,
            holdMs: effect.holdMs,
            quiet: true,
            citedNames: this.safeNames(effect.line.citedNames),
          });
        }
        break;
      }
      case "reveal": {
        if (!this.current(effect.beatId)) break;
        let take = this.visualTakes.get(effect.beatId);
        if (effect.fresh) {
          const line = this.state.current?.line;
          if (!line) break;
          take = this.options.voice.nextTakeId();
          this.visualTakes.set(effect.beatId, take);
          this.options.overlay({
            type: "line",
            take,
            text: line.text,
            dissent: line.dissent,
            dissentPct: line.dissentPct,
            pct: line.pct,
            voices: line.voices,
            mood: line.mood,
            question: line.question,
            answersQuestion: line.answersQuestion,
            templated: line.templated,
            showAgreement: line.showAgreement ?? true,
            citedNames: this.safeNames(line.citedNames),
            holdMs: this.state.settings.holdMs,
            quiet: false,
          });
        }
        if (take !== undefined) this.options.overlay({ type: "reveal", take });
        break;
      }
      case "prepareVoice":
        this.prepare(effect.beatId, effect.line);
        break;
      case "play":
        this.task(async () => {
          if (!this.current(effect.beatId)) return;
          const take = this.takes.get(effect.beatId)?.[effect.channel];
          const book = this.records.books.get(effect.beatId);
          if (!take || !book) return;
          if (effect.channel === "main") book.playAt = this.clock.now();
          await take.play();
          const playback = await take.ended;
          if (
            playback.reason !== "ended" &&
            this.state.current?.id === effect.beatId &&
            this.state.current.purpose === "split"
          ) {
            this.dispatch({ type: "invalidate", reason: "playback_stopped" });
            return;
          }
          if (playback.reason === "ended") this.shownEnds.set(effect.beatId, this.clock.now());
          else this.shownEnds.delete(effect.beatId);
          if (this.current(effect.beatId))
            this.dispatch({
              type: "voiceEnded",
              beatId: effect.beatId,
              channel: effect.channel,
              take: take.id,
            });
        }, "play");
        break;
      case "cancelVoice": {
        this.laughs.cancel();
        this.options.voice.cancelAll();
        if (effect.beatId !== null) this.takes.delete(effect.beatId);
        else this.takes.clear();
        break;
      }
      case "post":
        this.task(async () => {
          if (!this.current(effect.beatId)) return;
          try {
            const result = await this.options.output.post(
              effect.line,
              this.resultAdmission(effect.beatId),
            );
            if (!this.current(effect.beatId)) return;
            const book = this.records.books.get(effect.beatId);
            if (book && (!result.sent || result.dropReason)) {
              book.gate = "chat";
              book.reason =
                result.dropReason ?? (result.suppressed ? "duplicate_suppressed" : "not_sent");
            }
            this.dispatch({
              type: "postDone",
              beatId: effect.beatId,
              sent: result.sent,
              messageId: result.messageId,
              dropReason: result.dropReason,
            });
          } catch {
            if (!this.current(effect.beatId)) return;
            const book = this.records.books.get(effect.beatId);
            if (book) {
              book.gate = "chat";
              book.reason = "helix_error";
            }
            this.dispatch({
              type: "postDone",
              beatId: effect.beatId,
              sent: false,
              messageId: null,
              dropReason: "helix_error",
            });
          }
        }, "post");
        break;
      case "pin":
        this.task(async () => {
          if (!this.current(effect.beatId)) return;
          try {
            await this.options.output.pin(
              effect.messageId,
              effect.durationS,
              this.resultAdmission(effect.beatId),
            );
          } catch {
            if (!this.current(effect.beatId)) return;
            this.options.log.warn({ endpoint: "/chat/pins" }, "Beat pin unavailable");
            const book = this.records.books.get(effect.beatId);
            if (book) {
              book.gate = "pin";
              book.reason = "helix_error";
            }
          }
          this.dispatch({ type: "pinDone", beatId: effect.beatId });
        }, "pin");
        break;
      case "unpin":
        this.task(() => this.options.output.unpin(), "unpin");
        break;
      case "ack":
        this.task(async () => {
          await this.options.output.ack(effect.text);
        }, "ack");
        break;
      case "announce":
        this.task(() => this.options.output.announce(effect.question), "announce");
        break;
      case "persistSafety":
        this.options.store.settings.setSafety({
          muted: effect.muted,
          mutedUntil: effect.mutedUntil,
          killed: effect.killed,
        });
        break;
      case "log":
        if (effect.beat.purpose === "vote_result") this.votes.finishComplete();
        this.voteProposals.delete(effect.beat.id);
        this.shownEnds.delete(effect.beat.id);
        this.closedBeats++;
        this.records.write(
          effect.beat,
          this.state,
          effect.at,
          effect.status,
          effect.gate,
          effect.reason,
        );
        this.takes.delete(effect.beat.id);
        this.visualTakes.delete(effect.beat.id);
        break;
      case "emit": {
        if (effect.name === "state") {
          const view = this.view();
          this.options.overlay({ type: "state", ...view });
          this.options.control?.({ type: "state", ...view });
          for (const listener of this.stateListeners) listener(view);
        } else if (effect.name === "veto") {
          const take = effect.beatId === null ? undefined : this.takes.get(effect.beatId)?.main;
          if (effect.beatId !== null)
            this.options.overlay({
              type: "veto",
              take: this.visualTakes.get(effect.beatId) ?? take?.id ?? effect.beatId,
            });
        }
        break;
      }
    }
  }
  async startVote(a: string, b: string): Promise<{ ok: boolean; reason: string | null }> {
    if (!this.allowed()) return { ok: false, reason: "vote_blocked" };
    if (
      this.manualPending ||
      this.votes.busy() ||
      this.state.voteOpen ||
      this.state.step !== "listening"
    )
      return { ok: false, reason: "vote_busy" };
    this.manualPending = true;
    const controller = new AbortController();
    this.manualController = controller;
    try {
      const names = this.activity.names(this.clock.now());
      if (this.options.channelName) names.push(this.options.channelName);
      const checked = await this.votes.manual(a, b, names, controller.signal);
      if (!checked.proposal) return { ok: false, reason: checked.reason };
      if (!this.allowed()) return { ok: false, reason: "vote_blocked" };
      if (this.state.step !== "listening" || this.state.voteOpen || this.votes.busy())
        return { ok: false, reason: "vote_busy" };
      const line: BeatLine = {
        text: checked.proposal.text,
        dissent: null,
        dissentPct: null,
        pct: 0,
        voices: 0,
        mood: "chill",
        question: this.state.question,
        answersQuestion: true,
        templated: true,
        showAgreement: false,
        citedNames: [],
        citedExemplars: [],
        raidName: null,
      };
      this.dispatch({ type: "manualVote", line });
      const beat = this.state.current;
      if (beat?.purpose !== "split") return { ok: false, reason: "vote_cancelled" };
      this.voteProposals.set(beat.id, { choices: checked.proposal.choices, manual: true });
      return { ok: true, reason: null };
    } finally {
      this.manualPending = false;
      this.manualController = null;
    }
  }
  private finishVote(result: ReturnType<ChatVote["result"]> | null) {
    if (!result) {
      if (this.state.current?.purpose === "vote_result")
        this.dispatch({ type: "invalidate", reason: "vote_cancelled" });
      this.dispatch({ type: "voteFinished", line: null });
      return;
    }
    const version = this.votes.version();
    this.task(async () => {
      const safe = await this.verifyTemplate(result.text);
      if (version !== this.votes.version()) return;
      if (!this.state.voteOpen) return;
      const line: BeatLine | null =
        safe && this.allowed()
          ? {
              text: result.text,
              dissent: null,
              dissentPct: null,
              pct: result.pct,
              voices: result.n,
              mood: "chill",
              question: this.state.question,
              answersQuestion: true,
              templated: true,
              citedNames: [],
              citedExemplars: [],
              raidName: null,
            }
          : null;
      if (!line) this.votes.finishComplete();
      this.dispatch({ type: "voteFinished", line });
    }, "voteResult");
  }
  private async verifyTemplate(text: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    const checked = verifyTemplated(text, {
      blocklist: this.options.blocklist,
      moderation: { status: "ok", flagged: false },
    });
    if (!checked.ok) return false;
    try {
      const result = await this.options.moderation.moderate([text], signal);
      const item = result.results[0];
      return (
        !signal?.aborted &&
        result.results.length === 1 &&
        !!item &&
        verifyTemplated(text, {
          blocklist: this.options.blocklist,
          moderation: {
            status: "ok",
            flagged: item.flagged || Object.values(item.categories).some(Boolean),
          },
        }).ok
      );
    } catch {
      return false;
    }
  }
  private async resolveConsensus(effect: Extract<BeatEffect, { type: "synthesize" }>) {
    const snapshot = this.snapshots.get(effect.windowId);
    const questionGeneration = this.snapshotQuestions.get(effect.windowId);
    this.snapshotQuestions.delete(effect.windowId);
    this.snapshots.delete(effect.windowId);
    const beat = this.state.current;
    if (!snapshot || !beat || !this.current(effect.beatId)) return;
    const book = this.records.begin(beat, this.state.mode);
    book.snapshot = snapshot;
    book.windowVoices = assembleWindow(snapshot.messages, snapshot.windowOptions).voices;
    const controller = new AbortController();
    this.controllers.set(effect.beatId, controller);
    let exemplars = new Map<string, string[]>();
    const model: ConsensusModelPort = {
      generate: async (input, signal) => {
        if (!this.current(effect.beatId) || signal?.aborted)
          return fakeModelResult(null, { failure: "aborted", usage: null });
        const ticket = this.options.ledger.reserve(
          "consensus",
          this.clock.now(),
          this.records.key(effect.beatId),
          this.options.paidModel ? 0.0005 : 0,
        );
        if (!ticket) {
          this.dispatch({ type: "gate", changes: { capped: true } });
          return fakeModelResult(null, { failure: "aborted", usage: null });
        }
        this.publishCost();
        const generated = await this.options.model.generate(input, signal);
        this.options.ledger.settle(
          ticket,
          this.options.paidModel ? modelCost(generated.usage, this.options.tier ?? "fast") : 0,
          generated.usage,
        );
        this.records.update(effect.beatId);
        this.publishCost();
        if (generated.apiFailure) this.options.apiFailure?.("model");
        return generated;
      },
    };
    try {
      const mood = beatMoodSignals(this.state, this.clock.now());
      const result = await synthesize({
        messages: snapshot.messages,
        windowOptions: snapshot.windowOptions,
        question: effect.question,
        previousLine: effect.previousLine,
        questionChanged: effect.questionChanged,
        minVoices: this.state.settings.minVoices,
        moderation: this.moderation,
        outputModeration: this.options.moderation,
        model,
        blocklist: this.options.blocklist,
        signal: controller.signal,
        clock: this.clock,
        serviceTier: this.options.tier ?? "fast",
        moodContext: { raidActive: mood.raid_active, hypeLevel: mood.hype_level },
        onProcessing: (ms) => this.trackProcessing(ms),
        chooseTemplate: async (window, clusters) => {
          if (questionGeneration !== this.questionGeneration) return null;
          const proposal = await this.votes.propose(
            window,
            clusters,
            this.state.settings.minVoices,
            effect.question,
            controller.signal,
          );
          if (!proposal || !this.current(effect.beatId)) return null;
          this.voteProposals.set(effect.beatId, { choices: proposal.choices, manual: false });
          return proposal;
        },
        onWindow: (_window, clusters) => {
          exemplars = new Map(
            clusters.map((cluster) => [cluster.key, cluster.exemplars.map((item) => item.text)]),
          );
        },
      });
      book.result = result;
      this.dispatch({
        type: "synthDone",
        beatId: effect.beatId,
        result,
        citedExemplars: result.citedClusterKeys.flatMap((key) => exemplars.get(key) ?? []),
      });
    } finally {
      this.controllers.delete(effect.beatId);
    }
  }
  private prepare(beatId: number, line: BeatLine) {
    if (!this.current(beatId)) return;
    this.preparingBeatId = beatId;
    let main: VoiceTake;
    let dissent: VoiceTake | undefined;
    try {
      main = this.options.voice.prepare(line.text, "main");
      dissent = line.dissent ? this.options.voice.prepare(line.dissent, "dissent") : undefined;
    } finally {
      this.preparingBeatId = null;
    }
    this.takes.set(beatId, { main, ...(dissent ? { dissent } : {}) });
    this.visualTakes.set(beatId, main.id);
    this.options.control?.({
      type: "preview",
      take: main.id,
      text: line.text,
      dissent: line.dissent,
      dissentPct: line.dissentPct,
      pct: line.pct,
      voices: line.voices,
      holdMs: this.state.settings.holdMs,
      quiet: false,
    });
    this.takeBeats.set(main.id, beatId);
    if (dissent) this.takeBeats.set(dissent.id, beatId);
    while (this.takeBeats.size > 2000)
      this.takeBeats.delete(this.takeBeats.keys().next().value as number);
    this.options.overlay({
      type: "line",
      take: main.id,
      text: line.text,
      pct: line.pct,
      voices: line.voices,
      dissent: line.dissent,
      dissentPct: line.dissentPct,
      mood: line.mood,
      question: line.question,
      answersQuestion: line.answersQuestion,
      templated: line.templated,
      showAgreement: line.showAgreement ?? true,
      citedNames: this.safeNames(line.citedNames),
      holdMs: this.state.settings.holdMs,
      quiet: false,
    });
    for (const take of [main, dissent])
      if (take)
        this.task(async () => {
          const result = await take.ready;
          if (
            result.attempts.some(
              (attempt) => attempt.reason === "transport" || attempt.reason === "stall",
            )
          )
            this.options.apiFailure?.("voice");
          const book = this.records.books.get(beatId);
          if (book) {
            book.voices[take.result.channel] = result;
            if (take.result.channel === "main")
              book.readyMs = this.clock.now() - (book.previewAt ?? this.clock.now());
          }
          if (!this.current(beatId)) return;
          this.dispatch(
            result.status === "verified"
              ? { type: "voiceReady", beatId, channel: result.channel, take: take.id }
              : {
                  type: "captionOnly",
                  beatId,
                  channel: result.channel,
                  reason: result.attempts.at(-1)?.reason ?? "voice_unavailable",
                },
          );
        }, "prepareVoice");
  }
  report(event: PlaybackReport) {
    const beatId = this.takeBeats.get(event.take);
    if (beatId === undefined) return;
    const book = this.records.books.get(beatId);
    if (
      event.type === "started" &&
      book &&
      this.takes.get(beatId)?.main?.id === event.take &&
      book.startedAt === null
    ) {
      book.startedAt = this.clock.now();
      this.dispatch({ type: "voiceStarted", beatId, channel: "main", take: event.take });
    }
  }
  voteSnapshot() {
    return this.votes.snapshot();
  }
  canCheckVoice(): boolean {
    return (
      !this.state.muted &&
      !this.state.gates.killed &&
      !this.state.voteOpen &&
      !this.votes.busy() &&
      !["preview", "speaking", "synthesizing"].includes(this.state.step)
    );
  }
  private resultAdmission(beatId: number) {
    if (this.state.current?.purpose !== "vote_result") return undefined;
    const admission = this.votes.resultAdmission();
    if (!admission) throw new Error("Vote result cancelled");
    return { signal: admission.signal, allowed: () => admission.allowed() && this.current(beatId) };
  }
  allowVoiceAttempt(take: number, attempt: number): boolean {
    const beat = this.state.current;
    const resultTake =
      beat?.purpose === "vote_result" &&
      (this.takeBeats.get(take) === beat.id || this.preparingBeatId === beat.id);
    if (!this.allowed() || this.state.voteOpen || (this.votes.busy() && !resultTake)) return false;
    const beatId = this.takeBeats.get(take) ?? this.state.current?.id;
    const ticket = this.options.ledger.reserve(
      "voice",
      this.clock.now(),
      beatId === undefined ? null : this.records.key(beatId),
      this.options.paidVoice ? 0.0085 : 0,
    );
    if (!ticket) {
      this.dispatch({ type: "gate", changes: { capped: true } });
      return false;
    }
    this.tickets.set(`${take}:${attempt}`, ticket);
    this.publishCost();
    while (this.tickets.size > 4000)
      this.tickets.delete(this.tickets.keys().next().value as string);
    return true;
  }
  voiceUsage(take: number, attempt: number, usage: VoiceUsage | null, cost: number | null) {
    const ticket = this.tickets.get(`${take}:${attempt}`);
    if (!ticket) return;
    this.options.ledger.settle(ticket, this.options.paidVoice ? cost : 0, usage);
    const beatId = this.takeBeats.get(take);
    if (beatId !== undefined) this.records.update(beatId);
    this.refreshBudget();
  }
  async stop() {
    if (this.stopped) return;
    this.dispatch({ type: "off" });
    this.stopped = true;
    this.options.clips?.stop();
    this.votes.cancel("server stopped");
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    for (const interval of this.intervals) this.clock.clearInterval(interval);
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    this.collector.stop();
    await Promise.allSettled([...this.tasks]);
  }
}
