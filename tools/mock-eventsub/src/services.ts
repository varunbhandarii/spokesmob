export const mockScopes = Object.freeze([
  "user:read:chat",
  "user:write:chat",
  "user:bot",
  "channel:bot",
  "moderator:manage:announcements",
  "moderator:manage:chat_messages",
  "moderator:manage:chat_settings",
  "moderator:read:chatters",
  "moderator:read:blocked_terms",
  "clips:edit",
  "channel:manage:broadcast",
  "channel:read:hype_train",
  "channel:manage:redemptions",
  "channel:manage:polls",
]);

export interface MockCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
  at: number;
  clientIdPresent: boolean;
  authorizationPresent: boolean;
  clientSecretPresent: boolean;
}

export interface MockSubscription {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  transport: { method: string; session_id: string };
  created_at: string;
  cost: number;
}

export interface ScriptedFailure {
  status: number;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  body?: unknown;
}

export interface MockServiceOptions {
  clock?: { now(): number };
  clientId?: string;
  user?: { id: string; login: string; name: string };
  scopes?: readonly string[];
  online?: boolean;
}

const secretNames = /^(?:access_?token|refresh_?token|client_?secret|device_?code|authorization)$/i;

function redact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      secretNames.test(key) ? "[REDACTED]" : redactNested(item),
    ]),
  );
}

function redactNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactNested);
  return value && typeof value === "object" ? redact(value as Record<string, unknown>) : value;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function createMockServices(options: MockServiceOptions = {}) {
  const now = options.clock?.now ?? (() => Date.now());
  const clientId = options.clientId ?? "mock-client";
  const clips = new Map<string, { id: string; url: string; title: string; duration: number }>();
  const user = options.user ?? { id: "100000001", login: "spokesmob_demo", name: "Spokesmob Demo" };
  const calls: MockCall[] = [];
  const sessions = new Set<string>();
  const subscriptions = new Map<string, MockSubscription>();
  const failures: ScriptedFailure[] = [];
  const auth = {
    accessToken: "mock-access-0",
    refreshToken: "mock-refresh",
    scopes: [...(options.scopes ?? mockScopes)],
    userId: user.id,
    login: user.login,
    pendingPolls: 0,
    slowDownPolls: 0,
    pollResponses: [] as string[],
    invalidRefresh: false,
    expiresIn: 3600,
    deviceExpiresIn: 1800,
    interval: 5,
    validation401Count: 0,
    rotateRefresh: false,
  };
  let sequence = 0;
  let refreshCount = 0;
  let pin: Record<string, unknown> | undefined;
  let dropCode: string | undefined;
  let online = options.online ?? false;
  let startedAt = new Date(now()).toISOString();
  const setStreamLive = (value: boolean) => {
    if (value && !online) startedAt = new Date(now()).toISOString();
    online = value;
  };
  let settings: Record<string, unknown> = {
    broadcaster_id: user.id,
    slow_mode: false,
    unique_chat_mode: false,
    non_moderator_chat_delay: false,
  };
  let controls: {
    inject?: (frame: unknown) => void;
    reconnect?: () => void;
    close?: (code: number) => void;
    subscriptionCreated?: (subscription: MockSubscription) => void;
  } = {};

  const error = (status: number, message: string) =>
    json({ error: "Mock request error", status, message }, status);
  const tokenResponse = () =>
    json({
      access_token: auth.accessToken,
      refresh_token: auth.refreshToken,
      expires_in: auth.expiresIn,
      scope: auth.scopes,
      token_type: "bearer",
    });

  const fetchMock: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const method = request.method;
    let body: Record<string, unknown> = {};
    if (method !== "GET" && method !== "HEAD") {
      const text = await request.text();
      if (text) {
        body = request.headers.get("content-type")?.includes("application/json")
          ? (JSON.parse(text) as Record<string, unknown>)
          : Object.fromEntries(new URLSearchParams(text));
      }
    }
    const record: MockCall = {
      method,
      path: url.pathname,
      query: Object.fromEntries(
        [...url.searchParams].map(([key, value]) => [
          key,
          secretNames.test(key) ? "[REDACTED]" : value,
        ]),
      ),
      body: redact(body),
      at: now(),
      clientIdPresent: request.headers.has("client-id"),
      authorizationPresent: request.headers.has("authorization"),
      clientSecretPresent: typeof body.client_secret === "string" && body.client_secret.length > 0,
    };
    if (url.pathname !== "/control/calls") calls.push(record);
    const failIndex = failures.findIndex(
      (failure) =>
        (!failure.method || failure.method === method) &&
        (!failure.path || failure.path === url.pathname),
    );
    if (failIndex >= 0) {
      const failure = failures.splice(failIndex, 1)[0];
      if (failure)
        return json(
          failure.body ?? { status: failure.status, message: "Scripted failure" },
          failure.status,
          failure.headers,
        );
    }
    if (url.pathname === "/oauth2/device" && method === "POST") {
      if (body.client_id !== clientId || typeof body.scopes !== "string")
        return error(400, "Invalid client or scopes");
      return json({
        device_code: "mock-device-code",
        user_code: "MOCKCODE",
        verification_uri: "https://www.twitch.tv/activate",
        expires_in: auth.deviceExpiresIn,
        interval: auth.interval,
      });
    }
    if (url.pathname === "/oauth2/token" && method === "POST") {
      if (body.client_id !== clientId) return error(400, "Invalid client");
      if (body.grant_type === "refresh_token") {
        if (
          auth.invalidRefresh ||
          body.refresh_token !== auth.refreshToken ||
          !record.clientSecretPresent
        )
          return error(400, "Invalid refresh token");
        refreshCount += 1;
        auth.accessToken = `mock-access-${refreshCount}`;
        if (auth.rotateRefresh) auth.refreshToken = `mock-refresh-${refreshCount}`;
        return tokenResponse();
      }
      if (
        body.grant_type !== "urn:ietf:params:oauth:grant-type:device_code" ||
        body.device_code !== "mock-device-code"
      )
        return error(400, "Invalid device grant");
      const scripted = auth.pollResponses.shift();
      if (scripted) return error(400, scripted);
      if (auth.slowDownPolls-- > 0) return error(400, "slow_down");
      if (auth.pendingPolls-- > 0) return error(400, "authorization_pending");
      return tokenResponse();
    }
    if (url.pathname === "/oauth2/validate" && method === "GET") {
      if (
        auth.validation401Count-- > 0 ||
        request.headers.get("authorization") !== `OAuth ${auth.accessToken}`
      )
        return error(401, "Invalid access token");
      return json({
        client_id: clientId,
        login: auth.login,
        user_id: auth.userId,
        scopes: auth.scopes,
        expires_in: auth.expiresIn,
      });
    }
    if (url.pathname.startsWith("/control")) {
      const action = url.pathname.slice("/control/".length) || String(body.action ?? "");
      if (action === "calls") return json({ calls });
      if (action === "fail-next") failures.push(body as unknown as ScriptedFailure);
      else if (action === "inject") controls.inject?.(body.frame);
      else if (action === "reconnect") controls.reconnect?.();
      else if (action === "close") controls.close?.(Number(body.code ?? 4000));
      else if (action === "stream" && typeof body.online === "boolean") setStreamLive(body.online);
      return json({ ok: true });
    }
    if (!url.pathname.startsWith("/helix/")) return error(404, "Unknown route");
    if (request.headers.get("client-id") !== clientId) return error(401, "Client-Id is required");
    if (request.headers.get("authorization") !== `Bearer ${auth.accessToken}`)
      return error(401, "Invalid access token");
    const route = url.pathname.slice("/helix".length);
    if (route === "/eventsub/subscriptions") {
      if (method === "GET")
        return json({
          data: [...subscriptions.values()],
          total: subscriptions.size,
          total_cost: 0,
          max_total_cost: 10,
          pagination: {},
        });
      if (method === "DELETE") {
        subscriptions.delete(url.searchParams.get("id") ?? "");
        return json(null, 204);
      }
      if (method === "POST") {
        const transport = body.transport as MockSubscription["transport"] | undefined;
        const condition = body.condition as Record<string, string> | undefined;
        if (!transport || !sessions.has(transport.session_id) || !condition)
          return error(400, "Unknown session");
        if (String(body.type).startsWith("channel.chat.") && condition.user_id !== auth.userId)
          return error(403, "Condition user_id must equal token user");
        const duplicate = [...subscriptions.values()].find(
          (item) =>
            item.type === body.type &&
            item.version === body.version &&
            JSON.stringify(item.condition) === JSON.stringify(condition),
        );
        if (duplicate)
          return json(
            {
              error: "Conflict",
              status: 409,
              message: "subscription already exists",
              data: [{ id: duplicate.id }],
            },
            409,
          );
        const subscription: MockSubscription = {
          id: `subscription-${++sequence}`,
          status: "enabled",
          type: String(body.type),
          version: String(body.version),
          condition,
          transport,
          created_at: new Date(now()).toISOString(),
          cost: 0,
        };
        subscriptions.set(subscription.id, subscription);
        controls.subscriptionCreated?.(subscription);
        return json(
          { data: [subscription], total: subscriptions.size, total_cost: 0, max_total_cost: 10 },
          202,
        );
      }
    }
    if (route === "/streams" && method === "GET") {
      const ids = url.searchParams.getAll("user_id");
      const first = Number(url.searchParams.get("first") ?? 20);
      const type = url.searchParams.get("type") ?? "all";
      if (
        ids.length > 100 ||
        ids.some((id) => !/^\d+$/.test(id)) ||
        !Number.isInteger(first) ||
        first < 1 ||
        first > 100 ||
        !["all", "live"].includes(type)
      )
        return error(400, "Invalid stream filter");
      const matches = !ids.length || ids.includes(user.id);
      return json({
        data:
          online && matches
            ? [
                {
                  id: `stream-${user.id}`,
                  user_id: user.id,
                  user_login: user.login,
                  user_name: user.name,
                  game_id: "",
                  game_name: "",
                  type: "live",
                  title: "Synthetic stream",
                  tags: [],
                  viewer_count: 1,
                  started_at: startedAt,
                  language: "en",
                  thumbnail_url: "",
                  tag_ids: [],
                  is_mature: false,
                },
              ]
            : [],
        pagination: {},
      });
    }
    if (route === "/users" && method === "GET")
      return json({
        data: [
          {
            id: user.id,
            login: user.login,
            display_name: user.name,
            broadcaster_type: "",
            description: "Synthetic channel",
            type: "",
            profile_image_url: "",
            offline_image_url: "",
            created_at: "2020-01-01T00:00:00Z",
          },
        ],
      });
    if (route === "/chat/messages" && method === "POST") {
      if (
        typeof body.message !== "string" ||
        body.message.length > 500 ||
        "for_source_only" in body
      )
        return error(400, "Invalid chat message");
      const code = dropCode;
      dropCode = undefined;
      return json({
        data: [
          {
            message_id: `chat-${++sequence}`,
            is_sent: !code,
            drop_reason: code ? { code, message: "Scripted drop" } : null,
          },
        ],
      });
    }
    if (route === "/chat/pins") {
      if (method === "GET") return json({ data: pin ? [pin] : [] });
      if (method === "DELETE") {
        pin = undefined;
        return json(null, 204);
      }
      if (method === "PUT" && pin?.message_id === url.searchParams.get("message_id"))
        return error(409, "Message is already pinned");
      if (method === "PUT" || method === "PATCH") {
        const duration = Number(url.searchParams.get("duration_seconds"));
        if (duration < 30 || duration > 1800 || !Number.isFinite(duration))
          return error(400, "Invalid pin duration");
        pin = {
          broadcaster_id: url.searchParams.get("broadcaster_id"),
          moderator_id: url.searchParams.get("moderator_id"),
          message_id: url.searchParams.get("message_id"),
          duration_seconds: duration,
          ends_at: new Date(now() + duration * 1000).toISOString(),
        };
        return json(null, 204);
      }
    }
    if (route === "/clips") {
      if (method === "POST") {
        if (!online) return error(404, "Broadcaster is offline");
        const title = url.searchParams.get("title") ?? "Mock clip";
        const duration = Number(url.searchParams.get("duration") ?? 30);
        if (
          !url.searchParams.get("broadcaster_id") ||
          [...title].length > 100 ||
          duration < 5 ||
          duration > 60
        )
          return error(400, "Invalid clip parameters");
        const id = `clip-${++sequence}`;
        clips.set(id, { id, url: `https://clips.twitch.tv/${id}`, title, duration });
        return json(
          { data: [{ id, edit_url: `https://www.twitch.tv/spokesmob_demo/clip/${id}` }] },
          202,
        );
      }
      if (method === "GET") {
        const clip = clips.get(url.searchParams.get("id") ?? "");
        return json({ data: clip ? [clip] : [] });
      }
    }
    if (route === "/streams/markers" && method === "POST") {
      if (!online) return error(404, "Broadcaster is offline or VOD unavailable");
      if (
        body.user_id !== user.id ||
        typeof body.description !== "string" ||
        [...body.description].length > 140
      )
        return error(400, "Invalid marker");
      return json({
        data: [
          {
            id: `marker-${++sequence}`,
            created_at: new Date(now()).toISOString(),
            position_seconds: 30,
          },
        ],
      });
    }
    if (route === "/chat/announcements" && method === "POST") return json(null, 204);
    if (route === "/chat/settings") {
      if (method === "PATCH") settings = { ...settings, ...body };
      return json({ data: [settings] });
    }
    if (route === "/moderation/blocked_terms" && method === "GET")
      return json({ data: [], pagination: {} });
    return error(404, "Unknown Helix route");
  };

  return {
    fetch: fetchMock,
    auth,
    calls,
    sessions,
    subscriptions,
    clientId,
    user,
    registerSession: (id: string) => sessions.add(id),
    failNext: (failure: ScriptedFailure) => failures.push(failure),
    dropNextChat: (code: string) => {
      dropCode = code;
    },
    setStreamLive,
    setControls: (handlers: typeof controls) => {
      controls = handlers;
    },
  };
}

export type MockServices = ReturnType<typeof createMockServices>;
