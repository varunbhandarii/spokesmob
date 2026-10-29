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
import { modelCost } from "../../../../packages/core/src/cost.js";
import {
  beatMoodSignals,
  createEventLineState,
  reduceEventLine,
} from "../../../../packages/core/src/event-lines.js";
import type {
  ControlMessage,
  OverlayMessage,
} from "../../../../packages/core/src/overlay-protocol.js";
import { verifyTemplated } from "../../../../packages/core/src/verify.js";
import { assembleWindow } from "../../../../packages/core/src/window.js";
import { type Clock, systemClock } from "../clock.js";
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
import type { ChatOutput } from "./output.js";
import { BeatRecords } from "./records.js";

export interface BeatRunnerOptions {
  bus: TwitchBus;
  online: Pick<StreamStatus, "snapshot" | "onChange">;
  store: Repositories;
  ledger: SpendLedger;
  settings: BeatSettings;
  sessionId: string;
  voice: Pick<VoiceManager, "prepare" | "cancelAll">;
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
}
export class BeatRunner {
  state: BeatState;
  private readonly clock: Clock;
  private readonly collector: ConsensusCollector;
  private readonly moderation: ModerationGate;
  private readonly snapshots = new Map<number, CollectorSnapshot>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly takes = new Map<number, { main?: VoiceTake; dissent?: VoiceTake }>();
  private readonly takeBeats = new Map<number, number>();
  private readonly tickets = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
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
    this.collector = new ConsensusCollector({
      bus: options.bus,
      moderation: this.moderation,
      blocklist: options.blocklist,
      clock: this.clock,
      seed: options.seed ?? 17,
      log: options.log,
      windowOptions: () => ({ gaggedUsers: new Set(options.store.gags.list()) }),
    });
    this.records = new BeatRecords(
      options.store,
      options.sessionId,
      (row) => options.control?.({ type: "log", row }),
      (names) => this.safeNames(names),
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
  private sampleWindow() {
    if (!this.state.collection) return;
    const snapshot = this.collector.snapshot();
    const window = assembleWindow(snapshot.messages, snapshot.windowOptions);
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
      case "openWindow":
        this.collector.open(effect.window.startAt);
        break;
      case "closeWindow": {
        if (effect.nextWindow) this.snapshots.set(effect.windowId, this.collector.roll(effect.at));
        else this.collector.close();
        break;
      }
      case "slideWindow":
        this.collector.slide(effect.startAt);
        break;
      case "setTimer": {
        const previous = this.timers.get(effect.timer.kind);
        if (previous) this.clock.clearTimeout(previous);
        const timer = this.clock.setTimeout(
          () => {
            this.timers.delete(effect.timer.kind);
            this.dispatch({ type: "tick", timer: effect.timer.kind, id: effect.timer.id });
          },
          Math.max(0, effect.timer.at - this.clock.now()),
        );
        this.timers.set(effect.timer.kind, timer);
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
        if (effect.quiet)
          this.options.overlay({
            type: "line",
            text: effect.line.text,
            pct: effect.line.pct,
            voices: effect.line.voices,
            dissent: effect.line.dissent,
            mood: effect.line.mood,
            question: effect.line.question,
            answersQuestion: effect.line.answersQuestion,
            templated: effect.line.templated,
            take: effect.beatId,
            holdMs: effect.holdMs,
            quiet: true,
            citedNames: this.safeNames(effect.line.citedNames),
          });
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
          await take.ended;
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
        this.options.voice.cancelAll();
        if (effect.beatId !== null) this.takes.delete(effect.beatId);
        else this.takes.clear();
        break;
      }
      case "post":
        this.task(async () => {
          if (!this.current(effect.beatId)) return;
          try {
            const result = await this.options.output.post(effect.line);
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
            await this.options.output.pin(effect.messageId, effect.durationS);
          } catch {
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
        this.records.write(
          effect.beat,
          this.state,
          effect.at,
          effect.status,
          effect.gate,
          effect.reason,
        );
        this.takes.delete(effect.beat.id);
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
            this.options.overlay({ type: "veto", take: take?.id ?? effect.beatId });
        }
        break;
      }
    }
  }
  private async verifyTemplate(text: string): Promise<boolean> {
    const checked = verifyTemplated(text, {
      blocklist: this.options.blocklist,
      moderation: { status: "ok", flagged: false },
    });
    if (!checked.ok) return false;
    try {
      const result = await this.options.moderation.moderate([text]);
      const item = result.results[0];
      return (
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
    const main = this.options.voice.prepare(line.text, "main");
    const dissent = line.dissent ? this.options.voice.prepare(line.dissent, "dissent") : undefined;
    this.takes.set(beatId, { main, ...(dissent ? { dissent } : {}) });
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
      mood: line.mood,
      question: line.question,
      answersQuestion: line.answersQuestion,
      templated: line.templated,
      citedNames: this.safeNames(line.citedNames),
      holdMs: this.state.settings.holdMs,
      quiet: false,
    });
    for (const take of [main, dissent])
      if (take)
        this.task(async () => {
          const result = await take.ready;
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
  allowVoiceAttempt(take: number, attempt: number): boolean {
    if (!this.allowed()) return false;
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
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    for (const interval of this.intervals) this.clock.clearInterval(interval);
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
    this.collector.stop();
    await Promise.allSettled([...this.tasks]);
  }
}
