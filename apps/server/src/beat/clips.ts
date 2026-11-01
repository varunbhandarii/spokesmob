import type { Logger } from "pino";
import { cutAtWord } from "../../../../packages/core/src/laugh.js";
import type {
  ControlMessage,
  OverlayMessage,
} from "../../../../packages/core/src/overlay-protocol.js";
import { atDeadline, type Clock, systemClock } from "../clock.js";
import { type HelixClient, HelixError } from "../twitch/helix.js";

export class ClipCapture {
  private readonly clock: Clock;
  private stopped = false;
  private waits = new Set<() => void>();
  constructor(
    private readonly options: {
      helix: Pick<HelixClient, "createClip" | "getClips" | "createStreamMarker">;
      online(): boolean;
      overlay(message: OverlayMessage): void;
      control(message: ControlMessage): void;
      log: Pick<Logger, "warn">;
      clock?: Clock;
    },
  ) {
    this.clock = options.clock ?? systemClock;
  }
  stop() {
    this.stopped = true;
    for (const cancel of this.waits) cancel();
    this.waits.clear();
  }
  private activity(text: string, url: string | null = null) {
    if (!this.stopped)
      this.options.control({ type: "activity", kind: "clip", at: this.clock.now(), text, url });
  }
  private wait(at: number) {
    return new Promise<void>((resolve) => {
      const cancel = atDeadline(this.clock, at, () => {
        this.waits.delete(stop);
        resolve();
      });
      const stop = () => {
        cancel();
        resolve();
      };
      this.waits.add(stop);
    });
  }
  async capture(text: string) {
    if (this.stopped) return;
    if (!this.options.online()) {
      this.activity("Clip skipped: the stream is offline.");
      return;
    }
    await Promise.all([this.clip(text), this.marker(text)]);
  }
  private async marker(text: string) {
    try {
      await this.options.helix.createStreamMarker(cutAtWord(`Spokesmob: ${text}`, 140));
      this.activity("Stream marker created.");
    } catch (error) {
      this.failure("Stream marker", error);
    }
  }
  private failure(label: string, error: unknown) {
    const status = error instanceof HelixError ? error.status : 0;
    const reason = error instanceof HelixError ? error.reason : null;
    this.activity(
      `${label} failed: ${reason === "clips_disabled" ? "clips are disabled or restricted" : reason === "vod_unavailable" ? 'enable "Store past broadcasts" before creating markers' : status === 404 ? "the stream is offline or its VOD is unavailable" : status === 403 ? "Twitch denied access; check channel clip settings" : `Twitch request unavailable (${status})`}.`,
    );
    this.options.log.warn(
      { endpoint: label === "Clip" ? "/clips" : "/streams/markers", status },
      "Capture unavailable",
    );
  }
  private async clip(text: string) {
    try {
      let created: { id: string };
      const title = cutAtWord(text, 100);
      try {
        created = await this.options.helix.createClip(title || undefined);
      } catch (error) {
        if (
          !(error instanceof HelixError) ||
          error.status !== 400 ||
          error.reason !== "clip_title_rejected" ||
          !title
        )
          throw error;
        created = await this.options.helix.createClip();
      }
      const deadline = this.clock.now() + 60000;
      for (let next = this.clock.now() + 5000; next <= deadline; next = this.clock.now() + 5000) {
        await this.wait(next);
        if (this.stopped || this.clock.now() > deadline) return;
        const clip = (await this.options.helix.getClips(created.id))[0];
        if (clip) {
          this.activity(`Clipped: ${text}`, clip.url);
          this.options.overlay({ type: "event", kind: "clip" });
          return;
        }
      }
      this.activity("Clip failed: Twitch did not confirm it within 60 seconds.");
    } catch (error) {
      this.failure("Clip", error);
    }
  }
}
