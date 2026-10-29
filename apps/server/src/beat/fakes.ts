import { type Clock, systemClock } from "../clock.js";
import type { PlaybackReport, VoiceTake } from "../voice/manager.js";
import type { VoiceChannel, VoiceResult } from "../voice/types.js";

export class FakeVoice {
  private sequence = 0;
  private readonly takes = new Map<number, { take: VoiceTake; cancel(): void }>();
  readonly prepared: { text: string; channel: VoiceChannel }[] = [];
  readonly played: number[] = [];
  onReport: (event: PlaybackReport) => void = () => undefined;
  constructor(
    private readonly clock: Clock = systemClock,
    private readonly durationMs = 1000,
    private readonly readyMs = 300,
  ) {}
  prepare(text: string, channel: VoiceChannel): VoiceTake {
    const id = ++this.sequence;
    const result: VoiceResult = {
      take: id,
      channel,
      status: "verified",
      attempts: [],
      verifiedAtMs: null,
      durationMs: this.durationMs,
      trim: { leadingMs: 0, trailingMs: 0, totalMs: 0 },
    };
    let ready: (value: VoiceResult) => void = () => undefined;
    let ended: (value: { reason: "ended" | "cancelled" | "duration_fallback" }) => void = () =>
      undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let cancelled = false;
    let playing = false;
    const schedule = (callback: () => void, ms: number) => {
      const timer = this.clock.setTimeout(() => {
        timers.delete(timer);
        callback();
      }, ms);
      timers.add(timer);
    };
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      result.status = "cancelled";
      for (const timer of timers) this.clock.clearTimeout(timer);
      timers.clear();
      ready(result);
      ended({ reason: "cancelled" });
      this.onReport({ type: "stopped", take: id });
      this.takes.delete(id);
    };
    const take: VoiceTake = {
      id,
      result,
      ready: new Promise((resolve) => {
        ready = resolve;
      }),
      ended: new Promise((resolve) => {
        ended = resolve;
      }),
      play: async () => {
        await take.ready;
        if (cancelled || playing || result.status !== "verified") return;
        playing = true;
        this.played.push(id);
        schedule(() => this.onReport({ type: "started", take: id }), 100);
        schedule(() => {
          this.onReport({ type: "ended", take: id });
          ended({ reason: "ended" });
          this.takes.delete(id);
        }, 100 + this.durationMs);
      },
      cancel,
    };
    this.prepared.push({ text, channel });
    this.takes.set(id, { take, cancel });
    schedule(() => {
      if (!cancelled) {
        result.verifiedAtMs = result.status === "verified" ? this.clock.now() : null;
        ready(result);
      }
    }, this.readyMs);
    return take;
  }
  cancelAll() {
    for (const value of this.takes.values()) value.cancel();
  }
}
