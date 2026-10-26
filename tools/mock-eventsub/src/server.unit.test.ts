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
