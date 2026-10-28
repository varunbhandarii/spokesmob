import type { Logger } from "pino";
import { VOICE_THRESHOLDS as T } from "../../../../packages/core/src/voice-thresholds.js";
import { type Clock, systemClock } from "../clock.js";
import { voiceCost } from "./cost.js";
import { verifyAndTrim } from "./gates.js";
import { RealtimeSession } from "./session.js";
import type { RealtimeFactory } from "./transport.js";
import type { VoiceAttemptRecord, VoiceChannel, VoiceResult, VoiceUsage } from "./types.js";

export type PlaybackReport =
  | { type: "started" | "ended" | "stopped"; take: number }
  | { type: "played"; take: number; samples: number };
export interface VoiceTransport {
  prepare(take: number, channel: VoiceChannel, text: string): void;
  play(take: number, channel: VoiceChannel, pcm: Uint8Array, durationMs: number): void;
  stop(take: number | "all"): void;
}
export interface VoiceTake {
  id: number;
  ready: Promise<VoiceResult>;
  ended: Promise<{ reason: "ended" | "cancelled" | "duration_fallback" }>;
  play(): Promise<void>;
  cancel(reason?: string): void;
  result: VoiceResult;
}
interface TakeState {
  take: VoiceTake;
  controller: AbortController;
  pcm: Uint8Array | null;
  played: boolean;
  resolveReady(result: VoiceResult): void;
  resolveEnded(result: { reason: "ended" | "cancelled" | "duration_fallback" }): void;
  timer: ReturnType<typeof setTimeout> | null;
}
interface Slot {
  session: RealtimeSession;
  replacement: RealtimeSession | null;
  rotation: ReturnType<typeof setTimeout> | null;
  busy: number | null;
}
export class VoiceManager {
  private readonly clock: Clock;
  private readonly slots: Record<VoiceChannel, Slot>;
  private readonly takes = new Map<number, TakeState>();
  private readonly usageTargets = new Map<string, VoiceAttemptRecord>();
  private readonly earlyUsage = new Map<string, VoiceUsage | null>();
  private sequence = 0;
  private stopped = false;
  private muted = false;
  constructor(
    private readonly options: {
      mainVoice: string;
      dissentVoice: string;
      factory: RealtimeFactory;
      transport: VoiceTransport;
      clock?: Clock;
      log?: Pick<Logger, "info">;
      allowAttempt?: () => boolean;
      onUsage?: (
        take: number,
        attempt: number,
        usage: VoiceUsage | null,
        costUsd: number | null,
      ) => void;
    },
  ) {
    this.clock = options.clock ?? systemClock;
    this.slots = {
      main: { session: this.newSession("main"), replacement: null, rotation: null, busy: null },
      dissent: {
        session: this.newSession("dissent"),
        replacement: null,
        rotation: null,
        busy: null,
      },
    };
  }
  private newSession(channel: VoiceChannel): RealtimeSession {
    return new RealtimeSession({
      voice: channel === "main" ? this.options.mainVoice : this.options.dissentVoice,
      factory: this.options.factory,
      clock: this.clock,
      seed: channel === "main" ? 41 : 42,
      onUsage: (key, usage) => {
        const target = this.usageTargets.get(key);
        if (target) {
          target.usage = usage;
          target.costUsd = voiceCost(usage);
        } else this.earlyUsage.set(key, usage);
        const [take, attempt] = key.split(":").map(Number);
        if (take !== undefined && attempt !== undefined)
          this.options.onUsage?.(take, attempt, usage, voiceCost(usage));
      },
    });
  }
  async start(): Promise<void> {
    await Promise.all(
      (Object.keys(this.slots) as VoiceChannel[]).map((channel) => this.connectSlot(channel)),
    );
  }
  private async connectSlot(channel: VoiceChannel) {
    const slot = this.slots[channel];
    await slot.session.connect();
    this.scheduleRotation(channel);
  }
  private scheduleRotation(channel: VoiceChannel) {
    const slot = this.slots[channel];
    if (slot.rotation || this.stopped) return;
    const age = slot.session.health().sessionAgeS * 1000;
    slot.rotation = this.clock.setTimeout(
      () => {
        slot.rotation = null;
        slot.replacement = this.newSession(channel);
        void slot.replacement
          .connect()
          .then(() => this.swapIfIdle(channel))
          .catch(() => undefined);
      },
      Math.max(0, 50 * 60_000 - age),
    );
  }
  private swapIfIdle(channel: VoiceChannel) {
    const slot = this.slots[channel];
    if (slot.busy !== null || !slot.replacement?.health().ok || this.stopped) return;
    slot.session.close();
    slot.session = slot.replacement;
    slot.replacement = null;
    this.scheduleRotation(channel);
  }
  health() {
    return {
      main: this.slots.main.session.health(),
      dissent: this.slots.dissent.session.health(),
      muted: this.muted,
    };
  }
  prepare(line: string, channel: VoiceChannel = "main"): VoiceTake {
    const id = ++this.sequence;
    const controller = new AbortController();
    const result: VoiceResult = {
      take: id,
      channel,
      status: "caption_only",
      attempts: [],
      verifiedAtMs: null,
      durationMs: 0,
      trim: null,
    };
    let resolveReady!: (value: VoiceResult) => void;
    let resolveEnded!: TakeState["resolveEnded"];
    const ready = new Promise<VoiceResult>((resolve) => {
      resolveReady = resolve;
    });
    const ended = new Promise<{ reason: "ended" | "cancelled" | "duration_fallback" }>(
      (resolve) => {
        resolveEnded = resolve;
      },
    );
    const take: VoiceTake = {
      id,
      ready,
      ended,
      result,
      play: async () => {
        await ready;
        const state = this.takes.get(id);
        if (
          !state ||
          state.played ||
          !state.pcm ||
          result.status !== "verified" ||
          controller.signal.aborted ||
          this.muted ||
          this.stopped
        )
          return;
        state.played = true;
        this.options.transport.play(id, channel, state.pcm, result.durationMs);
        state.pcm = null;
        state.timer = this.clock.setTimeout(
          () => this.finishPlayback(id, "duration_fallback"),
          result.durationMs + 350,
        );
      },
      cancel: (reason = "cancelled") => this.cancel(id, reason),
    };
    const state: TakeState = {
      take,
      controller,
      pcm: null,
      played: false,
      resolveReady,
      resolveEnded,
      timer: null,
    };
    this.takes.set(id, state);
    if (this.stopped || this.muted) {
      this.cancel(id, "muted");
      return take;
    }
    const slot = this.slots[channel];
    if (slot.busy !== null) this.cancel(slot.busy, "superseded");
    this.swapIfIdle(channel);
    slot.busy = id;
    this.options.transport.prepare(id, channel, line);
    void this.generate(state, line).catch(() => {
      if (!controller.signal.aborted) result.status = "caption_only";
      state.resolveReady(result);
      state.resolveEnded({ reason: "cancelled" });
      if (slot.busy === id) slot.busy = null;
      this.swapIfIdle(channel);
    });
    return take;
  }
  private async generate(state: TakeState, line: string) {
    const result = state.take.result;
    const slot = this.slots[result.channel];
    for (
      let attempt = 1;
      attempt <= T.MAX_ATTEMPTS && !state.controller.signal.aborted;
      attempt++
    ) {
      if (this.options.allowAttempt && !this.options.allowAttempt()) break;
      const key = `${result.take}:${attempt}`;
      const generated = await slot.session.run({
        take: key,
        line,
        signal: state.controller.signal,
      });
      this.scheduleRotation(result.channel);
      const record: VoiceAttemptRecord = {
        reason: generated.reason,
        detail: generated.detail,
        ttfaMs: generated.ttfaMs,
        completeMs: generated.completeMs,
        similarity: null,
        audioMetrics: null,
        usage: generated.usage,
        costUsd: voiceCost(generated.usage),
      };
      if (this.earlyUsage.has(key)) {
        record.usage = this.earlyUsage.get(key) ?? null;
        record.costUsd = voiceCost(record.usage);
        this.earlyUsage.delete(key);
      }
      result.attempts.push(record);
      this.usageTargets.set(key, record);
      while (this.usageTargets.size > 1000) {
        const oldest = this.usageTargets.keys().next().value;
        if (oldest) this.usageTargets.delete(oldest);
      }
      if (!generated.reason && !state.controller.signal.aborted) {
        const verified = verifyAndTrim({
          rawPcm: generated.pcm,
          line,
          transcript: generated.transcript,
          channel: result.channel,
        });
        record.similarity = verified.similarity;
        record.audioMetrics = verified.audioMetrics;
        if (verified.ok) {
          result.status = "verified";
          result.verifiedAtMs = this.clock.now();
          result.durationMs = verified.durationMs;
          result.trim = verified.trim;
          state.pcm = verified.pcm;
          break;
        }
        record.reason = verified.reason;
        record.detail = verified.failures.join(",") || "transcript";
      }
    }
    if (slot.busy === result.take) slot.busy = null;
    this.swapIfIdle(result.channel);
    if (state.controller.signal.aborted) result.status = "cancelled";
    state.resolveReady(result);
    if (result.status !== "verified") {
      state.pcm = null;
      state.resolveEnded({ reason: "cancelled" });
      this.takes.delete(result.take);
    }
    this.options.log?.info(
      {
        ...result,
        attempts: result.attempts.map((attempt) => ({
          ...attempt,
          audioMetrics: attempt.audioMetrics,
        })),
      },
      "Voice take resolved",
    );
  }
  private cancel(id: number, reason: string) {
    const state = this.takes.get(id);
    if (!state) return;
    state.controller.abort();
    state.pcm = null;
    state.take.result.status = "cancelled";
    state.resolveReady(state.take.result);
    this.options.transport.stop(id);
    this.finishPlayback(id, "cancelled");
    const slot = this.slots[state.take.result.channel];
    if (slot.busy === id) slot.busy = null;
    this.options.log?.info({ take: id, reason }, "Voice take cancelled");
  }
  private finishPlayback(id: number, reason: "ended" | "cancelled" | "duration_fallback") {
    const state = this.takes.get(id);
    if (!state) return;
    if (state.timer) this.clock.clearTimeout(state.timer);
    state.pcm = null;
    if (reason === "duration_fallback") this.options.transport.stop(id);
    state.resolveEnded({ reason });
    this.takes.delete(id);
  }
  report(event: PlaybackReport) {
    const state = this.takes.get(event.take);
    if (!state?.played) return;
    if (event.type === "ended" || event.type === "stopped")
      this.finishPlayback(event.take, event.type === "ended" ? "ended" : "cancelled");
  }
  cancelAll() {
    for (const id of [...this.takes.keys()]) this.cancel(id, "cancel_all");
    this.options.transport.stop("all");
  }
  setMuted(value: boolean) {
    this.muted = value;
    if (value) this.cancelAll();
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelAll();
    for (const slot of Object.values(this.slots)) {
      if (slot.rotation) this.clock.clearTimeout(slot.rotation);
      slot.session.close();
      slot.replacement?.close();
    }
    this.usageTargets.clear();
    this.earlyUsage.clear();
  }
}
