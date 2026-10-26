import type { Logger } from "pino";
import { WebSocket } from "ws";
import { z } from "zod";
import { type Clock, systemClock } from "../clock.js";
import type { Config } from "../config.js";
import type { TokenProvider } from "./auth.js";
import { type SessionState, TwitchBus } from "./bus.js";
import { type EventSubFrame, frameSchema, mapNotification } from "./events.js";
import { type HelixClient, HelixError, type Subscription, type SubscriptionSpec } from "./helix.js";
import { subscriptionSpecs } from "./subscriptions.js";

interface Connection {
  socket: WebSocket;
  id?: string;
  welcomed: boolean;
  keepalive: number;
  watchdog?: ReturnType<typeof setTimeout>;
}
const sessionSchema = z
  .object({ id: z.string().min(1), keepalive_timeout_seconds: z.number().positive().nullish() })
  .passthrough();

export class EventSubClient {
  readonly bus: TwitchBus;
  readonly subscriptions = new Map<string, Subscription>();
  state: SessionState = "idle";
  private readonly clock: Clock;
  private readonly specs: SubscriptionSpec[];
  private active: Connection | undefined;
  private pending: Connection | undefined;
  private readonly sockets = new Set<Connection>();
  private readonly seen = new Map<string, number>();
  private running = false;
  private failures = 0;
  private reconnectCount = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stable: ReturnType<typeof setTimeout> | undefined;
  private readonly random: () => number;

  constructor(
    private readonly options: {
      config: Config;
      auth: TokenProvider;
      helix: HelixClient;
      channelId: string;
      log: Logger;
      bus?: TwitchBus;
      clock?: Clock;
      random?: () => number;
      onRaw?: (frame: EventSubFrame) => void;
      specs?: SubscriptionSpec[];
    },
  ) {
    this.bus = options.bus ?? new TwitchBus();
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.specs =
      options.specs ?? subscriptionSpecs(options.channelId, options.auth.identity.userId);
  }

  get sessionId(): string | undefined {
    return this.active?.id;
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.connectBase();
  }

  private setState(state: SessionState): void {
    this.state = state;
    this.options.log.info({ state, sessionId: this.active?.id }, "EventSub state");
    this.bus.health({
      kind: "session",
      state,
      ...(this.active?.id ? { sessionId: this.active.id } : {}),
    });
  }

  private connectBase(): void {
    if (!this.running) return;
    const url = new URL(this.options.config.eventsubUrl);
    if (!url.searchParams.has("keepalive_timeout_seconds"))
      url.searchParams.set("keepalive_timeout_seconds", "30");
    this.setState("connecting");
    this.connect(url.href, false);
  }

  private connect(url: string, handover: boolean): void {
    const connection: Connection = {
      socket: new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 2 * 1024 * 1024 }),
      welcomed: false,
      keepalive: 10_000,
    };
    this.sockets.add(connection);
    if (handover) this.pending = connection;
    else this.active = connection;
    this.watch(connection);
    connection.socket.on("message", (data) => {
      if (!this.running || (connection !== this.active && connection !== this.pending)) return;
      this.watch(connection);
      let input: unknown;
      try {
        input = JSON.parse(data.toString());
      } catch {
        this.options.log.warn("Invalid EventSub JSON dropped");
        return;
      }
      const parsed = frameSchema.safeParse(input);
      if (!parsed.success) {
        this.options.log.warn("Malformed EventSub frame dropped");
        return;
      }
      this.options.onRaw?.(parsed.data);
      this.receive(connection, parsed.data);
    });
    connection.socket.on("ping", () => {
      this.watch(connection);
      this.options.log.debug("EventSub ping received; automatic pong enabled");
    });
    connection.socket.on("error", () => {
      this.options.log.warn("EventSub transport error");
      this.fail(connection, "transport_error");
    });
    connection.socket.on("close", (code) => {
      this.sockets.delete(connection);
      if (connection.watchdog) this.clock.clearTimeout(connection.watchdog);
      if (code === 4001 || code === 4007)
        this.options.log.error({ code }, "EventSub client protocol bug");
      if (connection === this.active || connection === this.pending)
        this.fail(connection, `close_${code}`);
    });
  }

  private watch(connection: Connection): void {
    if (connection.watchdog) this.clock.clearTimeout(connection.watchdog);
    if (connection !== this.active && connection !== this.pending) return;
    connection.watchdog = this.clock.setTimeout(
      () => {
        this.options.log.warn({ sessionId: connection.id }, "EventSub watchdog expired");
        this.fail(connection, "watchdog");
      },
      connection.welcomed ? connection.keepalive * 1.2 : 10_000,
    );
  }

  private receive(connection: Connection, frame: EventSubFrame): void {
    if (!this.running || (connection !== this.active && connection !== this.pending)) return;
    switch (frame.metadata.message_type) {
      case "session_welcome":
        void this.welcome(connection, frame).catch(() =>
          this.fail(connection, "subscription_error"),
        );
        break;
      case "session_reconnect": {
        if (connection !== this.active || this.pending) return;
        const reconnect = z
          .object({ reconnect_url: z.url().refine((url) => /^wss?:/.test(url)) })
          .safeParse(frame.payload.session);
        if (!reconnect.success) {
          this.options.log.warn("Invalid EventSub reconnect instruction");
          this.fail(connection, "invalid_reconnect");
          return;
        }
        this.setState("reconnecting");
        // Twitch's supplied URL is opaque; do not rebuild its query or path.
        this.connect(reconnect.data.reconnect_url, true);
        break;
      }
      case "notification":
        this.notification(frame);
        break;
      case "revocation": {
        const result = z
          .object({ id: z.string(), type: z.string(), status: z.string() })
          .safeParse(frame.payload.subscription);
        if (!result.success) {
          this.options.log.warn("Malformed EventSub revocation dropped");
          return;
        }
        const subscription = result.data;
        this.subscriptions.delete(subscription.id);
        this.options.log.warn(
          { subscriptionId: subscription.id, type: subscription.type, status: subscription.status },
          "EventSub subscription revoked",
        );
        this.bus.health({ kind: "subscription", ...subscription });
        if (subscription.status === "authorization_revoked") this.authRequired();
        break;
      }
    }
  }

  private async welcome(connection: Connection, frame: EventSubFrame): Promise<void> {
    if (connection.welcomed) return;
    const session = sessionSchema.safeParse(frame.payload.session);
    if (!session.success) {
      this.options.log.warn("Malformed EventSub welcome dropped");
      return;
    }
    connection.welcomed = true;
    connection.id = session.data.id;
    connection.keepalive =
      (session.data.keepalive_timeout_seconds ?? (this.active?.keepalive ?? 30_000) / 1000) * 1000;
    this.watch(connection);
    if (connection === this.pending) {
      const previous = this.active;
      this.active = connection;
      this.pending = undefined;
      for (const subscription of this.subscriptions.values())
        subscription.transport.session_id = connection.id;
      if (previous) this.close(previous);
      this.reconnectCount++;
      this.bus.health({
        kind: "reconnect",
        count: this.reconnectCount,
        reason: "server_reconnect",
        resubscribed: false,
      });
      this.options.log.info(
        { sessionId: connection.id, subscriptions: this.subscriptions.size, resubscribed: false },
        "EventSub reconnect swapped",
      );
      this.ready(connection);
      return;
    }
    this.setState("welcomed");
    this.subscriptions.clear();
    this.setState("subscribing");
    const started = this.clock.now();
    const results = await Promise.allSettled(
      this.specs.map(async (spec) => {
        const subscription = await this.options.helix.createSubscription(spec, session.data.id);
        if (!this.running || connection !== this.active) {
          await this.options.helix.deleteSubscription(subscription.id).catch(() => undefined);
          return;
        }
        this.subscriptions.set(subscription.id, subscription);
        const elapsedMs = this.clock.now() - started;
        this.bus.health({
          kind: "subscription",
          type: spec.type,
          status: subscription.status,
          id: subscription.id,
          elapsedMs,
        });
        this.options.log.info(
          { type: spec.type, subscriptionId: subscription.id, elapsedMs },
          "EventSub subscribed",
        );
      }),
    );
    if (!this.running || connection !== this.active) return;
    const errors = results.filter((result) => result.status === "rejected");
    if (!errors.length) {
      this.ready(connection);
      return;
    }
    for (const result of errors) {
      const error: unknown = result.reason;
      if (error instanceof HelixError && error.status === 403) {
        this.options.log.error("EventSub subscription permissions missing");
        this.authRequired();
        return;
      }
      if (error instanceof HelixError && error.transportLimit) {
        this.options.log.error("EventSub transport limit reached; cleaning stale subscriptions");
        await this.cleanupStaleSubscriptions();
      }
    }
    this.fail(connection, "subscription_error");
  }

  private ready(connection: Connection): void {
    this.setState("ready");
    if (this.stable) this.clock.clearTimeout(this.stable);
    this.stable = this.clock.setTimeout(() => {
      if (this.active === connection && this.state === "ready") this.failures = 0;
    }, 60_000);
  }

  private notification(frame: EventSubFrame): void {
    const now = this.clock.now();
    for (const [messageId, expires] of this.seen) if (expires <= now) this.seen.delete(messageId);
    if (
      now - Date.parse(frame.metadata.message_timestamp) > 600_000 ||
      this.seen.has(frame.metadata.message_id)
    )
      return;
    this.seen.set(frame.metadata.message_id, now + 600_000);
    const event = mapNotification(frame, this.options.auth.identity.userId, this.options.log);
    if (!event) return;
    this.bus.health({ kind: "event", at: event.at });
    this.options.log.debug({ event }, "Twitch event");
    this.bus.emit(event);
  }

  async cleanupStaleSubscriptions(): Promise<void> {
    const subscriptions = await this.options.helix.listSubscriptions();
    await Promise.allSettled(
      subscriptions
        .filter(
          (subscription) =>
            subscription.transport.method === "websocket" &&
            subscription.transport.session_id !== this.active?.id,
        )
        .map((subscription) => this.options.helix.deleteSubscription(subscription.id)),
    );
    for (const socket of this.sockets)
      if (socket !== this.active && socket !== this.pending) this.close(socket, true);
  }

  private fail(connection: Connection, reason: string): void {
    if (!this.running || (connection !== this.active && connection !== this.pending)) return;
    const active = this.active;
    const pending = this.pending;
    this.active = undefined;
    this.pending = undefined;
    if (active) this.close(active, true);
    if (pending) this.close(pending, true);
    if (this.stable) this.clock.clearTimeout(this.stable);
    this.subscriptions.clear();
    this.setState("backoff");
    this.reconnectCount++;
    this.bus.health({ kind: "reconnect", count: this.reconnectCount, reason, resubscribed: true });
    const base = Math.min(30_000, 1000 * 2 ** Math.min(this.failures++, 5));
    const delay = Math.min(30_000, base + base * 0.25 * this.random());
    this.retry = this.clock.setTimeout(() => {
      this.retry = undefined;
      this.connectBase();
    }, delay);
  }

  private close(connection: Connection, terminate = false): void {
    if (connection.watchdog) this.clock.clearTimeout(connection.watchdog);
    if (terminate || connection.socket.readyState === WebSocket.CONNECTING)
      connection.socket.terminate();
    else if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close(1000);
      const timeout = this.clock.setTimeout(() => connection.socket.terminate(), 1000);
      timeout.unref?.();
      connection.socket.once("close", () => this.clock.clearTimeout(timeout));
    }
  }

  authRequired(): void {
    this.options.auth.requireSignIn();
    this.bus.health({ kind: "auth", state: "auth_required" });
    void this.stop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retry) this.clock.clearTimeout(this.retry);
    if (this.stable) this.clock.clearTimeout(this.stable);
    this.retry = undefined;
    this.stable = undefined;
    const ids = [...this.subscriptions.keys()];
    this.active = undefined;
    this.pending = undefined;
    for (const connection of this.sockets) this.close(connection);
    this.subscriptions.clear();
    await Promise.allSettled(ids.map((id) => this.options.helix.deleteSubscription(id)));
    this.setState("idle");
  }
}
