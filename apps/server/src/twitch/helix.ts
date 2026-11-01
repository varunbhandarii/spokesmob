import type { Logger } from "pino";
import { z } from "zod";
import { type Clock, sleep, systemClock } from "../clock.js";
import type { Config } from "../config.js";
import type { AccessTokenProvider } from "./auth.js";
import { ChatGuard } from "./chat-guard.js";
import type { Fetch } from "./device-flow.js";
import { type RateClass, RateLimiter, resetTime } from "./rate-limit.js";

export interface SubscriptionSpec {
  type: string;
  version: string;
  condition: Record<string, string>;
}
export interface Subscription extends SubscriptionSpec {
  id: string;
  status: string;
  transport: { method: string; session_id?: string };
  created_at?: string;
}
export interface User {
  id: string;
  login: string;
  display_name: string;
}
const streamSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().regex(/^\d+$/),
  user_login: z.string().min(1),
  user_name: z.string().min(1),
  game_id: z.string(),
  game_name: z.string(),
  type: z.enum(["live", ""]),
  title: z.string(),
  tags: z.array(z.string()),
  viewer_count: z.number().int().nonnegative(),
  started_at: z.iso.datetime({ offset: true }),
  language: z.string(),
  thumbnail_url: z.string(),
  tag_ids: z.array(z.string()),
  is_mature: z.boolean(),
});
export type Stream = z.infer<typeof streamSchema>;
export interface ChatResult {
  messageId: string | null;
  sent: boolean;
  dropReason: string | null;
  suppressed: boolean;
}
export interface PinnedMessage {
  message_id: string;
  broadcaster_id: string;
  ends_at?: string;
}
export interface BlockedTerm {
  id: string;
  text: string;
}
export interface ChatSettings {
  slow_mode?: boolean;
  slow_mode_wait_time?: number;
  follower_mode?: boolean;
  follower_mode_duration?: number;
  subscriber_mode?: boolean;
  emote_mode?: boolean;
  unique_chat_mode?: boolean;
  non_moderator_chat_delay?: boolean;
  non_moderator_chat_delay_duration?: number;
}
interface Page<T> {
  data: T[];
  pagination?: { cursor?: string };
}

export class HelixError extends Error {
  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly transportLimit = false,
    readonly reason: "clip_title_rejected" | "clips_disabled" | "vod_unavailable" | null = null,
  ) {
    super(`Twitch request failed (${status}) at ${endpoint}`);
    this.name = "HelixError";
  }
}

export class HelixClient {
  private readonly clock: Clock;
  private readonly fetcher: Fetch;
  private readonly limiter: RateLimiter;
  private readonly guard: ChatGuard;
  private channelId: string;

  constructor(
    private readonly options: {
      config: Config;
      auth: AccessTokenProvider;
      channelId?: string;
      log: Logger;
      clock?: Clock;
      fetch?: Fetch;
      limiter?: RateLimiter;
    },
  ) {
    this.clock = options.clock ?? systemClock;
    this.fetcher = options.fetch ?? fetch;
    this.limiter = options.limiter ?? new RateLimiter(this.clock);
    this.guard = new ChatGuard(options.log, this.clock);
    this.channelId = options.channelId ?? "";
  }

  setChannel(id: string): void {
    this.channelId = id;
  }
  private channel(): string {
    if (!this.channelId) throw new Error("Twitch channel has not been resolved");
    return this.channelId;
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      query?: URLSearchParams | Record<string, string>;
      body?: unknown;
      idempotent?: boolean;
      kind?: RateClass;
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.options.config.helixUrl}${path}`);
    url.search = new URLSearchParams(options.query).toString();
    let unauthorized = false;
    let rateRetried = false;
    let failures = 0;
    for (;;) {
      await this.limiter.acquire(options.kind);
      const token = await this.options.auth.getAccessToken();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers: {
            "Client-Id": this.options.config.clientId,
            Authorization: `Bearer ${token}`,
            ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new HelixError(0, path);
      }
      this.limiter.observe(response.headers);
      this.options.log.debug(
        { method, endpoint: path, status: response.status },
        "Twitch request completed",
      );
      const body: unknown =
        response.status === 204 ? undefined : await response.json().catch(() => undefined);
      if (response.ok) return body as T;
      if (options.idempotent && response.status === 401 && !unauthorized) {
        unauthorized = true;
        await this.options.auth.onUnauthorized(token);
        continue;
      }
      const remaining = response.headers.get("ratelimit-remaining");
      if (
        options.idempotent &&
        response.status === 429 &&
        !rateRetried &&
        (remaining === null || remaining === "0")
      ) {
        rateRetried = true;
        this.limiter.pauseUntil(resetTime(response.headers, this.clock.now()));
        continue;
      }
      if (options.idempotent && response.status >= 500 && failures < 3) {
        await sleep(this.clock, 500 * 2 ** failures++);
        continue;
      }
      // Provider error text is inspected only for this flag and is never propagated to logs.
      const transportLimit = response.status === 429 && /transports/i.test(JSON.stringify(body));
      const detail = JSON.stringify(body);
      const reason =
        path === "/clips" &&
        response.status === 400 &&
        /title.*automod|automod.*title/i.test(detail)
          ? "clip_title_rejected"
          : path === "/clips" && response.status === 403 && /disabled|not.*enabled/i.test(detail)
            ? "clips_disabled"
            : path === "/streams/markers" && /vod|past broadcasts/i.test(detail)
              ? "vod_unavailable"
              : null;
      throw new HelixError(response.status, path, transportLimit, reason);
    }
  }

  async getUsers({
    ids = [],
    logins = [],
  }: {
    ids?: string[];
    logins?: string[];
  } = {}): Promise<User[]> {
    const query = new URLSearchParams();
    for (const id of ids) query.append("id", id);
    for (const login of logins) query.append("login", login);
    return (await this.request<Page<User>>("GET", "/users", { query, idempotent: true })).data;
  }

  async createClip(title?: string): Promise<{ id: string }> {
    if (title !== undefined && (!title.trim() || [...title].length > 100))
      throw new Error("Clip title must contain 1-100 characters");
    const query = { broadcaster_id: this.channel(), duration: "30", ...(title ? { title } : {}) };
    const response = await this.request<unknown>("POST", "/clips", {
      query,
      kind: "general",
      idempotent: false,
    });
    return z
      .object({ data: z.array(z.object({ id: z.string().min(1) })).length(1) })
      .parse(response).data[0] as { id: string };
  }
  async getClips(id: string): Promise<{ id: string; url: string }[]> {
    if (!id || id.length > 200) throw new Error("Invalid clip ID");
    const response = await this.request<unknown>("GET", "/clips", {
      query: { id },
      kind: "general",
      idempotent: true,
    });
    const rows = z
      .object({
        data: z
          .array(
            z.object({
              id: z.string().min(1),
              url: z.url().refine((value) => {
                const url = new URL(value);
                return (
                  url.protocol === "https:" &&
                  ["clips.twitch.tv", "www.twitch.tv", "twitch.tv"].includes(url.hostname) &&
                  !url.username &&
                  !url.password
                );
              }),
            }),
          )
          .max(1),
      })
      .parse(response).data;
    if (rows.some((row) => row.id !== id)) throw new Error("Invalid clip response");
    return rows;
  }
  async createStreamMarker(description: string): Promise<{ id: string }> {
    if (!description.trim() || [...description].length > 140)
      throw new Error("Marker description must contain 1-140 characters");
    const response = await this.request<unknown>("POST", "/streams/markers", {
      body: { user_id: this.channel(), description },
      kind: "general",
      idempotent: false,
    });
    return z
      .object({ data: z.array(z.object({ id: z.string().min(1) })).length(1) })
      .parse(response).data[0] as { id: string };
  }
  async getStreams(): Promise<Stream[]> {
    const broadcasterId = this.channel();
    if (!/^\d+$/.test(broadcasterId))
      throw new Error("Resolved Twitch channel ID must contain only digits");
    const response = await this.request<unknown>("GET", "/streams", {
      query: { user_id: broadcasterId },
      kind: "general",
      idempotent: true,
    });
    const parsed = z.object({ data: z.array(streamSchema).max(1) }).safeParse(response);
    if (!parsed.success || parsed.data.data.some((stream) => stream.user_id !== broadcasterId)) {
      this.options.log.warn(
        { endpoint: "/streams", broadcasterId },
        "Invalid Twitch stream response",
      );
      throw new Error("Invalid Twitch stream response");
    }
    const streams = parsed.data.data;
    this.options.log.info(
      {
        endpoint: "/streams",
        broadcasterId,
        count: streams.length,
        online: streams.some((stream) => stream.type === "live"),
      },
      "Twitch stream status checked",
    );
    return streams;
  }

  async sendChatMessage({
    text,
    replyTo,
  }: {
    text: string;
    replyTo?: string;
  }): Promise<ChatResult> {
    if (text.length > 500) throw new Error("Chat messages must be at most 500 characters");
    if (!text.trim()) throw new Error("Chat messages must not be empty");
    const channel = this.channel();
    if (!this.guard.reserve(text))
      return { messageId: null, sent: false, dropReason: null, suppressed: true };
    let result: unknown;
    try {
      result = await this.request<unknown>("POST", "/chat/messages", {
        kind: "chat",
        body: {
          broadcaster_id: channel,
          sender_id: this.options.auth.identity.userId,
          message: text,
          ...(replyTo ? { reply_parent_message_id: replyTo } : {}),
        },
      });
    } finally {
      this.guard.complete(text);
    }
    const parsed = z
      .object({
        data: z
          .array(
            z.object({
              message_id: z.string(),
              is_sent: z.boolean(),
              drop_reason: z.object({ code: z.string() }).nullish(),
            }),
          )
          .optional(),
      })
      .safeParse(result ?? {});
    if (!parsed.success) throw new Error("Invalid Twitch chat response");
    const message = parsed.data.data?.[0];
    if (!message) {
      this.options.log.warn(
        { dropReason: "missing_response_entry" },
        "Chat send returned no message result",
      );
      return {
        messageId: null,
        sent: false,
        dropReason: "missing_response_entry",
        suppressed: false,
      };
    }
    return {
      messageId: message.message_id,
      sent: message.is_sent,
      dropReason: message.drop_reason?.code ?? null,
      suppressed: false,
    };
  }

  private moderatorQuery(): Record<string, string> {
    return { broadcaster_id: this.channel(), moderator_id: this.options.auth.identity.userId };
  }
  private pinQuery(id: string, seconds?: number): Record<string, string> {
    if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 30 || seconds > 1800))
      throw new Error("Pin duration must be 30 to 1800 seconds");
    return {
      ...this.moderatorQuery(),
      message_id: id,
      ...(seconds === undefined ? {} : { duration_seconds: String(seconds) }),
    };
  }
  async pinMessage(id: string, seconds = 60): Promise<void> {
    await this.request("PUT", "/chat/pins", {
      query: this.pinQuery(id, seconds),
      idempotent: true,
    });
  }
  async updatePin(id: string, seconds: number): Promise<void> {
    await this.request("PATCH", "/chat/pins", {
      query: this.pinQuery(id, seconds),
      idempotent: true,
    });
  }
  async unpinMessage(id: string): Promise<void> {
    await this.request("DELETE", "/chat/pins", { query: this.pinQuery(id), idempotent: true });
  }
  async getPin(): Promise<PinnedMessage | null> {
    return (
      (
        await this.request<Page<PinnedMessage>>("GET", "/chat/pins", {
          query: this.moderatorQuery(),
          idempotent: true,
        })
      ).data[0] ?? null
    );
  }
  async sendAnnouncement(
    text: string,
    color: "blue" | "green" | "orange" | "purple" | "primary" = "purple",
  ): Promise<void> {
    if ([...text].length > 500 || !text.trim())
      throw new Error("Announcements must contain 1 to 500 characters");
    await this.request("POST", "/chat/announcements", {
      query: this.moderatorQuery(),
      kind: "announce",
      body: { message: text, color },
    });
  }
  async getChatSettings(): Promise<ChatSettings> {
    return (
      (
        await this.request<Page<ChatSettings>>("GET", "/chat/settings", {
          query: this.moderatorQuery(),
          idempotent: true,
        })
      ).data[0] ?? {}
    );
  }
  async updateChatSettings(patch: ChatSettings): Promise<ChatSettings> {
    return (
      (
        await this.request<Page<ChatSettings>>("PATCH", "/chat/settings", {
          query: this.moderatorQuery(),
          body: patch,
          idempotent: true,
        })
      ).data[0] ?? {}
    );
  }
  async getBlockedTerms(): Promise<BlockedTerm[]> {
    return this.paginate("/moderation/blocked_terms", this.moderatorQuery());
  }
  private async paginate<T>(path: string, query: Record<string, string> = {}): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.request<Page<T>>("GET", path, {
        query: { ...query, first: "100", ...(cursor ? { after: cursor } : {}) },
        idempotent: true,
      });
      items.push(...page.data);
      cursor = page.pagination?.cursor;
      if (cursor && seen.has(cursor)) throw new Error("Twitch pagination did not advance");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async createSubscription(spec: SubscriptionSpec, sessionId: string): Promise<Subscription> {
    try {
      const result = await this.request<Page<Subscription>>("POST", "/eventsub/subscriptions", {
        body: { ...spec, transport: { method: "websocket", session_id: sessionId } },
        idempotent: true,
      });
      if (!result.data[0]) throw new Error("Missing Twitch subscription response");
      return result.data[0];
    } catch (error) {
      if (!(error instanceof HelixError) || error.status !== 409) throw error;
      const existing = (await this.listSubscriptions()).find(
        (item) =>
          item.type === spec.type &&
          item.version === spec.version &&
          Object.entries(spec.condition).every(([key, value]) => item.condition[key] === value),
      );
      if (!existing) throw error;
      return existing;
    }
  }
  async listSubscriptions(): Promise<Subscription[]> {
    return this.paginate("/eventsub/subscriptions");
  }
  async deleteSubscription(id: string): Promise<void> {
    await this.request("DELETE", "/eventsub/subscriptions", { query: { id }, idempotent: true });
  }
}
