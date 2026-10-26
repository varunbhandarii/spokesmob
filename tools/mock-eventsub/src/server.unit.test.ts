import { once } from "node:events";
import { setImmediate as immediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { type EventFrame, expandScenario, parseScenario } from "./scenario.js";
import { createMockServer, type MockClock, type MockServer } from "./server.js";

const servers: MockServer[] = [];
const sockets: WebSocket[] = [];
const clock: MockClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (timer) => clearInterval(timer),
};

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
  vi.useRealTimers();
});

function nextFrame(socket: WebSocket, type: string): Promise<EventFrame> {
  return new Promise((resolve) => {
    const onMessage = (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as EventFrame;
      if (frame.metadata.message_type === type) {
        socket.off("message", onMessage);
        resolve(frame);
      }
    };
    socket.on("message", onMessage);
  });
}

async function connect(server: MockServer, url = server.wsUrl) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const welcome = await nextFrame(socket, "session_welcome");
  return { socket, id: String(welcome.payload.session?.id), welcome };
}

async function subscribe(server: MockServer, sessionId: string) {
  return server.services.fetch(`${server.helixUrl}/eventsub/subscriptions`, {
    method: "POST",
    headers: {
      "client-id": server.services.clientId,
      authorization: `Bearer ${server.services.auth.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: server.services.user.id, user_id: server.services.user.id },
      transport: { method: "websocket", session_id: sessionId },
    }),
  });
}

test("mock WebSocket handover retains subscription IDs and overlaps event delivery", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  const server = await createMockServer({ clock, autoPlay: false });
  servers.push(server);
  const old = await connect(server, `${server.wsUrl}?keepalive_timeout_seconds=30`);
  expect(old.welcome.payload.session?.keepalive_timeout_seconds).toBe(30);
  expect((await subscribe(server, old.id)).status).toBe(202);
  const ids = [...server.services.subscriptions.keys()];
  const reconnect = nextFrame(old.socket, "session_reconnect");
  server.reconnect();
  const redirect = await reconnect;
  const current = await connect(server, String(redirect.payload.session?.reconnect_url));
  expect([...server.services.subscriptions.keys()]).toEqual(ids);
  expect([...server.services.subscriptions.values()][0]?.transport.session_id).toBe(current.id);
  const scenario = parseScenario(
    '{"scenario":"one","channel":{"id":"100000001","login":"spokesmob_demo"}}\n{"t":0,"kind":"chat","user":"viewer01","name":"Viewer 01","text":"Hello"}',
  );
  const line = expandScenario(scenario, { startAt: clock.now() })[0];
  if (line?.kind !== "notification") throw new Error("Expected notification");
  const oldEvent = nextFrame(old.socket, "notification");
  const newEvent = nextFrame(current.socket, "notification");
  server.inject(line.frame);
  expect((await oldEvent).metadata.message_id).toBe((await newEvent).metadata.message_id);
  expect(
    server.services.calls.filter(
      (call) => call.method === "POST" && call.path.endsWith("/subscriptions"),
    ),
  ).toHaveLength(1);
});

test("mock keepalive uses the clock, supports silence and closes unused sockets with 4003", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  const server = await createMockServer({ clock, autoPlay: false, unusedTimeoutMs: 11000 });
  servers.push(server);
  const connection = await connect(server);
  const keepalive = nextFrame(connection.socket, "session_keepalive");
  await vi.advanceTimersByTimeAsync(5000);
  expect((await keepalive).metadata.message_type).toBe("session_keepalive");
  let received = 0;
  connection.socket.on("message", () => {
    received += 1;
  });
  server.silence(6000);
  await vi.advanceTimersByTimeAsync(5000);
  await immediate();
  expect(received).toBe(0);
  const closed = once(connection.socket, "close");
  await vi.advanceTimersByTimeAsync(1000);
  expect((await closed)[0]).toBe(4003);
});

test("mock HTTP adapter serves auth and scripted failures without exposing credentials in calls", async () => {
  const server = await createMockServer();
  servers.push(server);
  const device = await fetch(`${server.authUrl}/device`, {
    method: "POST",
    body: new URLSearchParams({
      client_id: server.services.clientId,
      scopes: server.services.auth.scopes.join(" "),
    }),
  });
  expect(device.status).toBe(200);
  server.services.failNext({ status: 503, path: "/helix/users" });
  const headers = {
    "client-id": server.services.clientId,
    authorization: `Bearer ${server.services.auth.accessToken}`,
  };
  expect((await fetch(`${server.helixUrl}/users`, { headers })).status).toBe(503);
  const calls = await fetch(`${server.origin}/control/calls`);
  const serialized = await calls.text();
  expect(serialized).not.toContain(server.services.auth.accessToken);
  expect(serialized).not.toContain("mock-device-code");
});

function recordedFrame(): EventFrame {
  const scenario = parseScenario(
    '{"scenario":"archived","channel":{"id":"100000001","login":"spokesmob_demo"}}\n{"t":0,"kind":"chat","user":"viewer01","name":"Viewer 01","text":"Archived synthetic message"}',
  );
  const line = expandScenario(scenario, { startAt: Date.UTC(2000, 0, 1) })[0];
  if (line?.kind !== "notification") throw new Error("Expected notification");
  return {
    ...line.frame,
    payload: {
      ...line.frame.payload,
      subscription: {
        ...line.frame.payload.subscription,
        id: "archived-subscription",
        transport: { method: "websocket", session_id: "archived-session" },
      },
    },
  };
}

test("recording replay preserves archives and event content while adapting timing and transport IDs", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  const first = recordedFrame();
  const second = { ...first, metadata: { ...first.metadata, message_id: "archived-message-two" } };
  const revoked = {
    ...first,
    metadata: { ...first.metadata, message_id: "archived-revocation", message_type: "revocation" },
    payload: { subscription: { ...first.payload.subscription, status: "authorization_revoked" } },
  };
  const archived = [
    {
      t: 700,
      frame: {
        metadata: {
          message_id: "archived-welcome",
          message_type: "session_welcome",
          message_timestamp: first.metadata.message_timestamp,
        },
        payload: { session: { id: "archived-session" } },
      },
    },
    { t: 1200, frame: first },
    { t: 2200, frame: second },
    { t: 3200, frame: revoked },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  const scenario = parseScenario(archived);
  const before = structuredClone(scenario);
  const server = await createMockServer({ scenario, speed: 5, clock, autoPlay: false });
  servers.push(server);
  const connection = await connect(server);
  await subscribe(server, connection.id);
  const subscriptionId = [...server.services.subscriptions.keys()][0];
  const types: string[] = [];
  connection.socket.on("message", (raw: Buffer) => {
    types.push((JSON.parse(raw.toString()) as EventFrame).metadata.message_type);
  });
  const startedAt = clock.now();
  const firstResult = nextFrame(connection.socket, "notification");
  server.play();
  await vi.advanceTimersByTimeAsync(239);
  await immediate();
  expect(types).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  const playedFirst = await firstResult;
  expect(playedFirst.metadata.message_id).toBe(first.metadata.message_id);
  expect(playedFirst.metadata.message_timestamp).toBe(new Date(startedAt + 240).toISOString());
  expect(playedFirst.payload.event).toEqual(first.payload.event);
  expect(playedFirst.payload.subscription).toMatchObject({
    id: subscriptionId,
    transport: { session_id: connection.id },
  });
  const secondResult = nextFrame(connection.socket, "notification");
  await vi.advanceTimersByTimeAsync(200);
  const playedSecond = await secondResult;
  expect(playedSecond.metadata.message_timestamp).toBe(new Date(startedAt + 440).toISOString());
  expect(playedSecond.metadata.message_id).toBe("archived-message-two");
  const revocationResult = nextFrame(connection.socket, "revocation");
  await vi.advanceTimersByTimeAsync(200);
  const playedRevocation = await revocationResult;
  expect(playedRevocation.payload.subscription).toMatchObject({
    id: subscriptionId,
    status: "authorization_revoked",
    transport: { session_id: connection.id },
  });
  expect(server.services.subscriptions.size).toBe(0);
  expect(types).toEqual(["notification", "notification", "revocation"]);
  expect(scenario).toEqual(before);
});

test.each(["raw", "synthetic"] as const)(
  "later %s playback loops use unique envelope IDs",
  async (kind) => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const frame = recordedFrame();
    const source =
      kind === "raw"
        ? JSON.stringify({ t: 10, frame })
        : '{"scenario":"loop","channel":{"id":"100000001","login":"spokesmob_demo"}}\n{"t":10,"kind":"chat","user":"viewer01","name":"Viewer 01","text":"Hello"}';
    const scenario = parseScenario(source);
    const original = expandScenario(scenario)[0];
    if (original?.kind !== "notification") throw new Error("Expected notification");
    const server = await createMockServer({ scenario, loop: true, clock, autoPlay: false });
    servers.push(server);
    const connection = await connect(server);
    await subscribe(server, connection.id);
    const firstResult = nextFrame(connection.socket, "notification");
    server.play();
    await vi.advanceTimersByTimeAsync(10);
    const first = await firstResult;
    const secondResult = nextFrame(connection.socket, "notification");
    await vi.advanceTimersByTimeAsync(11);
    const second = await secondResult;
    expect(first.metadata.message_id).toBe(original.frame.metadata.message_id);
    expect(second.metadata.message_id).toBe(`${first.metadata.message_id}:loop:1`);
    expect(second.payload.event).toEqual(first.payload.event);
  },
);

test("literal timestamp replay preserves old timestamps for stale-frame checks", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  const frame = recordedFrame();
  const scenario = parseScenario(JSON.stringify({ t: 10, frame }));
  const server = await createMockServer({
    scenario,
    literalTimestamps: true,
    clock,
    autoPlay: false,
  });
  servers.push(server);
  const connection = await connect(server);
  await subscribe(server, connection.id);
  const result = nextFrame(connection.socket, "notification");
  server.play();
  await vi.advanceTimersByTimeAsync(10);
  const played = await result;
  expect(played.metadata.message_timestamp).toBe(frame.metadata.message_timestamp);
  expect(clock.now() - Date.parse(played.metadata.message_timestamp)).toBeGreaterThan(600000);
});
