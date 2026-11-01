import type { Logger } from "pino";
import type { Blocklist } from "../../../../packages/core/src/blocklist.js";
import { clusterWindow } from "../../../../packages/core/src/cluster.js";
import { fromTwitchChat } from "../../../../packages/core/src/normalize.js";
import { THRESHOLDS } from "../../../../packages/core/src/thresholds.js";
import type { ChatMessage } from "../../../../packages/core/src/types.js";
import { assembleWindow, type WindowOptions } from "../../../../packages/core/src/window.js";
import { type Clock, systemClock } from "../clock.js";
import type { TwitchBus } from "../twitch/bus.js";
import type { TwitchEvent } from "../twitch/events.js";

export interface CollectorSnapshot {
  messages: ChatMessage[];
  windowOptions: WindowOptions;
}

export class ConsensusCollector {
  private readonly clock: Clock;
  private readonly unsubscribe: () => void;
  private messages: ChatMessage[] = [];
  private deletedIds = new Set<string>();
  private clearedUsers = new Set<string>();
  private clearBefore: number | undefined;
  private startAt: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private controller: AbortController | undefined;
  private moderating = false;
  private stopped = false;

  constructor(
    private readonly options: {
      bus: TwitchBus;
      moderation: { premoderate(texts: readonly string[], signal?: AbortSignal): Promise<void> };
      blocklist: Blocklist;
      clock?: Clock;
      seed?: number;
      log?: Pick<Logger, "warn">;
      windowOptions?: () => Partial<WindowOptions>;
      acceptChat?(event: Extract<TwitchEvent, { kind: "chat" }>): boolean;
      onProcessing?(milliseconds: number): void;
    },
  ) {
    this.clock = options.clock ?? systemClock;
    this.unsubscribe = options.bus.onEvent((event) => this.receive(event));
  }

  open(startAt = this.clock.now()): void {
    if (this.stopped) throw new Error("Cannot open a stopped chat collector");
    this.reset();
    this.startAt = startAt;
    this.controller = new AbortController();
    this.timer = this.clock.setInterval(() => void this.premoderate(), 2000);
  }

  snapshot(overrides: Partial<WindowOptions> = {}): CollectorSnapshot {
    return {
      messages: structuredClone(this.messages),
      windowOptions: {
        seed: this.options.seed ?? 1,
        deletedIds: new Set(this.deletedIds),
        clearedUsers: new Set(this.clearedUsers),
        endAt: this.clock.now(),
        ...(this.startAt === undefined ? {} : { startAt: this.startAt }),
        ...(this.clearBefore === undefined ? {} : { clearBefore: this.clearBefore }),
        ...this.options.windowOptions?.(),
        ...overrides,
      },
    };
  }

  close(): CollectorSnapshot {
    const result = this.snapshot();
    this.reset();
    return result;
  }

  roll(at = this.clock.now()): CollectorSnapshot {
    const closed = this.snapshot({ endAt: at });
    this.open(at);
    return closed;
  }

  slide(startAt: number): void {
    if (this.startAt === undefined) return;
    this.startAt = Math.max(this.startAt, startAt);
    this.messages = this.messages.filter((message) => message.at >= (this.startAt ?? startAt));
    const retained = new Set(this.messages.map((message) => message.id));
    this.deletedIds = new Set([...this.deletedIds].filter((id) => retained.has(id)));
  }

  stop(): void {
    this.stopped = true;
    this.reset();
    this.unsubscribe();
  }

  private reset(): void {
    if (this.timer !== undefined) this.clock.clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    this.controller = undefined;
    this.startAt = undefined;
    this.messages = [];
    this.deletedIds.clear();
    this.clearedUsers.clear();
    this.clearBefore = undefined;
  }

  private receive(event: TwitchEvent): void {
    if (this.startAt === undefined) return;
    switch (event.kind) {
      case "chat":
        if (this.options.acceptChat && !this.options.acceptChat(event)) break;
        this.messages.push(fromTwitchChat(event));
        break;
      case "chatDelete":
        this.deletedIds.add(event.messageId);
        break;
      case "chatClearUser":
        this.clearedUsers.add(event.userId);
        break;
      case "chatClear":
        this.clearBefore = Math.max(
          this.clearBefore ?? Number.NEGATIVE_INFINITY,
          Date.parse(event.at),
        );
        break;
    }
  }

  private async premoderate(): Promise<void> {
    const signal = this.controller?.signal;
    if (!signal || signal.aborted || this.moderating) return;
    this.moderating = true;
    try {
      const started = performance.now();
      const snapshot = this.snapshot();
      const window = assembleWindow(snapshot.messages, snapshot.windowOptions);
      const clusters = clusterWindow(window, {
        isBlocked: (text) => this.options.blocklist.check(text).blocked,
      });
      this.options.onProcessing?.(performance.now() - started);
      const texts = clusters
        .slice(0, THRESHOLDS.TOP_CLUSTERS)
        .flatMap((cluster) => cluster.exemplars.map((exemplar) => exemplar.text))
        .slice(0, THRESHOLDS.TOP_CLUSTERS * THRESHOLDS.MAX_EXEMPLARS);
      if (texts.length) await this.options.moderation.premoderate(texts, signal);
    } catch {
      if (!signal.aborted) this.options.log?.warn("Provisional input moderation unavailable");
    } finally {
      this.moderating = false;
    }
  }
}
