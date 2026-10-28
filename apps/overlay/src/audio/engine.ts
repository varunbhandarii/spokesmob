import type { PlaybackReport } from "../protocol.js";
import { SampleRing } from "./ring.js";

export type PlayerCommand =
  | { type: "prepare"; take: number }
  | { type: "append"; take: number; sequence: number; samples: Float32Array }
  | { type: "play"; take: number; samples: number }
  | { type: "stop"; take: number | "all" };

export class RingPlayer {
  readonly ring: SampleRing;
  private take: number | null = null;
  private nextSequence = 0;
  private playing = false;
  private preRoll = 0;
  private played = 0;
  private expected = 0;
  private reportAt = 0;
  private started = false;
  private rejected = false;
  constructor(
    private readonly report: (event: PlaybackReport) => void,
    readonly sampleRate = 24000,
  ) {
    this.ring = new SampleRing(sampleRate * 30);
  }
  command(message: PlayerCommand): void {
    if (message.type === "prepare") {
      if (message.take === this.take) return;
      this.stop();
      this.take = message.take;
      this.rejected = false;
      this.nextSequence = 0;
      return;
    }
    if (message.type === "stop") {
      if (message.take === "all" || message.take === this.take) this.stop();
      return;
    }
    if (message.take !== this.take || this.rejected) return;
    if (message.type === "append") {
      if (
        this.playing ||
        message.sequence !== this.nextSequence ||
        !this.ring.push(message.samples)
      ) {
        this.reject();
        return;
      }
      this.nextSequence++;
      return;
    }
    if (message.type === "play") {
      if (this.playing) return;
      if (
        !Number.isSafeInteger(message.samples) ||
        message.samples <= 0 ||
        message.samples !== this.ring.available
      ) {
        this.reject();
        return;
      }
      this.expected = message.samples;
      this.preRoll = Math.round(this.sampleRate * 0.1);
      this.played = 0;
      this.reportAt = Math.round(this.sampleRate * 0.25);
      this.started = false;
      this.playing = true;
    }
  }
  private reject(): void {
    this.rejected = true;
    this.stop();
  }
  private stop(): void {
    const take = this.take;
    this.ring.clear();
    this.playing = false;
    this.preRoll = 0;
    this.played = 0;
    this.expected = 0;
    this.take = null;
    if (take !== null) this.report({ type: "stopped", take });
  }
  render(output: Float32Array): void {
    output.fill(0);
    if (!this.playing || this.take === null) return;
    const offset = Math.min(output.length, this.preRoll);
    this.preRoll -= offset;
    if (offset === output.length) return;
    const remaining = this.expected - this.played;
    const requested = Math.min(output.length - offset, remaining);
    if (this.ring.available < requested) {
      this.reject();
      return;
    }
    const amount = this.ring.read(output, offset, requested);
    if (!this.started && amount) {
      this.started = true;
      this.report({ type: "started", take: this.take });
    }
    this.played += amount;
    if (this.played >= this.reportAt || this.played === this.expected) {
      this.report({ type: "played", take: this.take, samples: this.played });
      this.reportAt = this.played + Math.round(this.sampleRate * 0.25);
    }
    if (this.played === this.expected) {
      const take = this.take;
      this.take = null;
      this.playing = false;
      this.ring.clear();
      this.report({ type: "ended", take });
    }
  }
}
