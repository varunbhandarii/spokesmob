import type { Logger } from "pino";
import type { TwitchBus } from "./bus.js";
import type { HelixClient } from "./helix.js";

export interface OnlineSnapshot {
  known: boolean;
  online: boolean;
}
export class StreamStatus {
  private value: OnlineSnapshot = { known: false, online: false };
  private readonly listeners = new Set<(value: OnlineSnapshot) => void>();
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private revision = 0;
  private lastEventAt = Number.NEGATIVE_INFINITY;
  private pending: Promise<OnlineSnapshot> | null = null;
  constructor(
    private readonly options: {
      helix: Pick<HelixClient, "getStreams">;
      channelId: string;
      bus: TwitchBus;
      log: Logger;
    },
  ) {}
  snapshot(): OnlineSnapshot {
    return { ...this.value };
  }
  onChange(listener: (value: OnlineSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private set(value: OnlineSnapshot) {
    if (this.value.known === value.known && this.value.online === value.online) return;
    this.value = value;
    this.options.log.info(
      { known: value.known, online: value.online },
      "Channel online state changed",
    );
    for (const listener of this.listeners) listener(this.snapshot());
  }
  start(): Promise<OnlineSnapshot> {
    if (!this.unsubscribe) {
      const streams = this.options.bus.on("stream", (event) => {
        const at = Date.parse(event.at);
        if (
          !Number.isFinite(at) ||
          at < this.lastEventAt ||
          (at === this.lastEventAt && event.online && !this.value.online)
        )
          return;
        this.lastEventAt = at;
        this.revision++;
        this.set({ known: true, online: event.online });
      });
      const health = this.options.bus.onHealth((event) => {
        if (
          (event.kind === "auth" && event.state === "auth_required") ||
          (event.kind === "session" && ["connecting", "backoff", "idle"].includes(event.state))
        ) {
          this.revision++;
          this.set({ known: false, online: false });
        } else if (event.kind === "session" && event.state === "ready") {
          const generation = this.generation;
          void (async () => {
            if (this.pending) await this.pending;
            if (generation === this.generation) await this.refresh();
          })().catch(() => {
            if (generation === this.generation) this.set({ known: false, online: false });
            this.options.log.warn({ endpoint: "/streams" }, "Stream status refresh unavailable");
          });
        }
      });
      this.unsubscribe = () => {
        streams();
        health();
      };
    }
    return this.refresh();
  }
  refresh(): Promise<OnlineSnapshot> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    const revision = this.revision;
    this.pending = (async () => {
      try {
        const streams = await this.options.helix.getStreams();
        if (generation === this.generation && revision === this.revision) {
          const valid = streams.every(
            (stream) => stream.user_id === this.options.channelId && stream.type === "live",
          );
          this.set({ known: valid, online: valid && streams.length > 0 });
        }
        return this.snapshot();
      } catch (error) {
        if (generation === this.generation && revision === this.revision)
          this.set({ known: false, online: false });
        throw error;
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
  stop() {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.set({ known: false, online: false });
  }
}
