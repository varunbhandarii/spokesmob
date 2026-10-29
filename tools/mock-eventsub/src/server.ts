import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { type EventFrame, type ExpandedLine, expandScenario, type Scenario } from "./scenario.js";
import { createMockServices, type MockServices } from "./services.js";

export interface MockClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface MockServerOptions {
  port?: number;
  host?: string;
  scenario?: Scenario;
  speed?: number;
  loop?: boolean;
  services?: MockServices;
  clock?: MockClock;
  unusedTimeoutMs?: number;
  autoPlay?: boolean;
  literalTimestamps?: boolean;
}

interface Session {
  id: string;
  socket: WebSocket;
  keepalive: ReturnType<typeof setInterval>;
  unused: ReturnType<typeof setTimeout>;
  silentUntil: number;
}

export async function createMockServer(options: MockServerOptions = {}) {
  const clock: MockClock = options.clock ?? {
    now: () => Date.now(),
    setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimeout: (timer) => clearTimeout(timer),
    setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
    clearInterval: (timer) => clearInterval(timer),
  };
  const services = options.services ?? createMockServices({ clock });
  const sessions = new Map<string, Session>();
  const transfers = new Map<string, string>();
  const aliases = new Map<string, string>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const scenario = options.scenario;
  const speed = options.speed ?? scenario?.header.speed ?? 1;
  if (!Number.isFinite(speed) || speed <= 0 || speed > 20)
    throw new Error("Playback speed must be above zero and at most 20");
  let sequence = 0;
  let playing = false;
  let played = false;
  let playbackPass = 0;
  let stopped = false;
  let origin = "";

  const send = (session: Session, frame: unknown) => {
    if (session.socket.readyState === WebSocket.OPEN && clock.now() >= session.silentUntil)
      session.socket.send(JSON.stringify(frame));
  };
  const sessionFrame = (messageType: string, session: Record<string, unknown>) => ({
    metadata: {
      message_id: `control-${++sequence}`,
      message_type: messageType,
      message_timestamp: new Date(clock.now()).toISOString(),
    },
    payload: { session },
  });
  const inject = (frame: EventFrame) => {
    const type = frame.metadata.subscription_type ?? frame.payload.subscription?.type;
    if (frame.metadata.message_type === "notification" && type === "stream.online")
      services.setStreamLive(true);
    if (frame.metadata.message_type === "notification" && type === "stream.offline")
      services.setStreamLive(false);
    const revoked = new Set<string>();
    for (const session of sessions.values()) {
      const subscription = [...services.subscriptions.values()].find(
        (item) =>
          item.transport.session_id === (aliases.get(session.id) ?? session.id) &&
          item.type === type,
      );
      if (type && !subscription) continue;
      const recorded = frame.payload.subscription ?? {};
      const mapped = subscription
        ? {
            ...recorded,
            id: subscription.id,
            type: subscription.type,
            version: subscription.version,
            status:
              frame.metadata.message_type === "revocation" ? recorded.status : subscription.status,
            transport: subscription.transport,
          }
        : undefined;
      send(
        session,
        mapped ? { ...frame, payload: { ...frame.payload, subscription: mapped } } : frame,
      );
      if (subscription && frame.metadata.message_type === "revocation")
        revoked.add(subscription.id);
    }
    for (const id of revoked) services.subscriptions.delete(id);
  };
  const reconnect = () => {
    for (const session of sessions.values()) {
      const transferId = `handover-${++sequence}`;
      transfers.set(transferId, session.id);
      send(
        session,
        sessionFrame("session_reconnect", {
          id: session.id,
          status: "reconnecting",
          keepalive_timeout_seconds: null,
          reconnect_url: `${origin.replace(/^http/, "ws")}/reconnect/${transferId}?keepalive_timeout_seconds=10`,
          connected_at: new Date(clock.now()).toISOString(),
        }),
      );
    }
  };
  const closeSockets = (code = 4000) => {
    for (const session of sessions.values()) session.socket.close(code, "Scripted close");
  };
  const silence = (milliseconds: number) => {
    for (const session of sessions.values()) session.silentUntil = clock.now() + milliseconds;
  };
  const revoke = (type: string, status: string) => {
    for (const subscription of [...services.subscriptions.values()]) {
      if (subscription.type !== type) continue;
      const session = sessions.get(subscription.transport.session_id);
      if (session)
        send(session, {
          metadata: {
            message_id: `revocation-${++sequence}`,
            message_type: "revocation",
            message_timestamp: new Date(clock.now()).toISOString(),
            subscription_type: type,
            subscription_version: subscription.version,
          },
          payload: { subscription: { ...subscription, status } },
        });
      services.subscriptions.delete(subscription.id);
    }
  };
  const apply = (line: ExpandedLine) => {
    if (line.kind === "notification") {
      inject(line.frame);
      return;
    }
    switch (line.action) {
      case "reconnect":
        reconnect();
        break;
      case "close":
        closeSockets(line.code ?? 4000);
        break;
      case "silence":
        silence(line.ms ?? 15000);
        break;
      case "revoke":
        revoke(line.type ?? "channel.chat.message", line.status ?? "authorization_revoked");
        break;
    }
  };
  const schedule = (callback: () => void, milliseconds: number) => {
    const timer = clock.setTimeout(() => {
      pendingTimers.delete(timer);
      if (!stopped) callback();
    }, milliseconds);
    pendingTimers.add(timer);
  };
  const play = () => {
    if (!scenario || playing || stopped) return;
    playing = true;
    played = true;
    const pass = playbackPass++;
    const start = clock.now();
    const lines = expandScenario(scenario, { startAt: start });
    lines.forEach((line, index) => {
      const raw = scenario.lines[index]?.kind === "raw";
      if (
        raw &&
        line.kind === "notification" &&
        line.frame.metadata.message_type.startsWith("session_")
      )
        return;
      schedule(() => {
        const next =
          line.kind === "notification"
            ? {
                ...line,
                frame: {
                  ...line.frame,
                  metadata: {
                    ...line.frame.metadata,
                    message_id:
                      pass === 0
                        ? line.frame.metadata.message_id
                        : `${line.frame.metadata.message_id}:loop:${pass}`,
                    message_timestamp:
                      raw && options.literalTimestamps
                        ? line.frame.metadata.message_timestamp
                        : new Date(clock.now()).toISOString(),
                  },
                },
              }
            : line;
        apply(next);
      }, line.t / speed);
    });
    const end = lines.reduce((maximum, line) => Math.max(maximum, line.t), 0) / speed + 1;
    schedule(() => {
      playing = false;
      if (options.loop) play();
    }, end);
  };

  const http = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
      }
      const body = Buffer.concat(chunks);
      const result = await services.fetch(`${origin}${request.url ?? "/"}`, {
        method: request.method ?? "GET",
        headers,
        ...(body.length ? { body } : {}),
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: 400, message: "Malformed mock request" }));
    }
  });
  const websocket = new WebSocketServer({ noServer: true });
  http.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/ws" && !path.startsWith("/reconnect/")) {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (connection) =>
      websocket.emit("connection", connection, request),
    );
  });
  websocket.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", origin);
    const transferKey = url.pathname.startsWith("/reconnect/")
      ? url.pathname.slice("/reconnect/".length)
      : undefined;
    const previousId = transferKey ? transfers.get(transferKey) : undefined;
    if (transferKey && !previousId) {
      socket.close(4007, "Invalid reconnect URL");
      return;
    }
    const timeout = Math.max(1, Number(url.searchParams.get("keepalive_timeout_seconds") ?? 10));
    const id = `session-${++sequence}`;
    services.registerSession(id);
    if (previousId) {
      aliases.set(previousId, id);
      for (const subscription of services.subscriptions.values()) {
        if (subscription.transport.session_id === previousId)
          subscription.transport.session_id = id;
      }
      if (transferKey) transfers.delete(transferKey);
    }
    const session: Session = {
      id,
      socket,
      silentUntil: 0,
      keepalive: clock.setInterval(
        () =>
          send(session, {
            metadata: {
              message_id: `keepalive-${++sequence}`,
              message_type: "session_keepalive",
              message_timestamp: new Date(clock.now()).toISOString(),
            },
            payload: {},
          }),
        timeout * 500,
      ),
      unused: clock.setTimeout(() => {
        if (
          ![...services.subscriptions.values()].some(
            (subscription) => subscription.transport.session_id === id,
          )
        )
          socket.close(4003, "Connection unused");
      }, options.unusedTimeoutMs ?? 10000),
    };
    sessions.set(id, session);
    send(
      session,
      sessionFrame("session_welcome", {
        id,
        status: "connected",
        connected_at: new Date(clock.now()).toISOString(),
        keepalive_timeout_seconds: timeout,
        reconnect_url: null,
      }),
    );
    socket.on("close", () => {
      clock.clearInterval(session.keepalive);
      clock.clearTimeout(session.unused);
      sessions.delete(id);
      aliases.delete(id);
      services.sessions.delete(id);
      for (const subscription of services.subscriptions.values()) {
        if (subscription.transport.session_id === id)
          services.subscriptions.delete(subscription.id);
      }
    });
    socket.on("error", () => {});
  });
  services.setControls({
    inject: (frame) => inject(frame as EventFrame),
    reconnect,
    close: closeSockets,
    subscriptionCreated: () => {
      if (options.autoPlay !== false && !playing && !played) schedule(play, 10);
    },
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Mock server did not bind a TCP port");
  origin = `http://${options.host ?? "127.0.0.1"}:${address.port}`;
  return {
    wsUrl: `${origin.replace(/^http/, "ws")}/ws`,
    helixUrl: `${origin}/helix`,
    authUrl: `${origin}/oauth2`,
    origin,
    services,
    sessions,
    inject,
    reconnect,
    closeSockets,
    silence,
    revoke,
    play,
    close: async () => {
      stopped = true;
      for (const timer of pendingTimers) clock.clearTimeout(timer);
      pendingTimers.clear();
      for (const session of sessions.values()) {
        clock.clearInterval(session.keepalive);
        clock.clearTimeout(session.unused);
        session.socket.terminate();
      }
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export type MockServer = Awaited<ReturnType<typeof createMockServer>>;
