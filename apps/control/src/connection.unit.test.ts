import { afterEach, expect, test, vi } from "vitest";
import { type ControlSocket, connectControl } from "./connection.js";
import { view } from "./test-data.js";

class FakeSocket implements ControlSocket {
  readyState = 0;
  onopen: ControlSocket["onopen"] = null;
  onmessage: ControlSocket["onmessage"] = null;
  onclose: ControlSocket["onclose"] = null;
  onerror: ControlSocket["onerror"] = null;
  sent: unknown[] = [];
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  open() {
    this.readyState = 1;
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }
  receive(value: unknown) {
    this.onmessage?.call(
      this as unknown as WebSocket,
      { data: typeof value === "string" ? value : JSON.stringify(value) } as MessageEvent,
    );
  }
  close() {
    this.readyState = 3;
    this.onclose?.call(this as unknown as WebSocket, {} as CloseEvent);
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const location = { protocol: "http:", host: "127.0.0.1:4040", search: "?token=synthetic" };

test("the default browser clock arms hello and reconnect deadlines without rebinding host timers", async () => {
  vi.useFakeTimers();
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const scheduled = vi.spyOn(globalThis, "setTimeout").mockImplementation(function (
    this: unknown,
    callback,
    milliseconds,
  ) {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    return schedule(callback, milliseconds);
  });
  const cancelled = vi.spyOn(globalThis, "clearTimeout").mockImplementation(function (
    this: unknown,
    timer,
  ) {
    if (this !== undefined) throw new TypeError("Illegal invocation");
    cancel(timer);
  });
  const sockets: FakeSocket[] = [];
  const connection = connectControl({
    location,
    state: () => {},
    message: () => {},
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  expect(() => sockets[0]?.open()).not.toThrow();
  expect(scheduled).toHaveBeenLastCalledWith(expect.any(Function), 5000);
  sockets[0]?.receive({ type: "hello", role: "control", audio: false, state: view });
  expect(cancelled).toHaveBeenCalled();
  expect(() => sockets[0]?.close()).not.toThrow();
  expect(scheduled).toHaveBeenLastCalledWith(expect.any(Function), 1000);
  await vi.advanceTimersByTimeAsync(999);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);
  sockets[1]?.open();
  expect(scheduled).toHaveBeenLastCalledWith(expect.any(Function), 5000);
  sockets[1]?.close();
  expect(() => connection.close()).not.toThrow();
  await vi.advanceTimersByTimeAsync(10000);
  expect(sockets).toHaveLength(2);
});

test("the control panel keeps retrying localhost at a maximum five-second delay", async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const connection = connectControl({
    location,
    message: () => {},
    state: () => {},
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  for (const delay of [1000, 2000, 4000, 5000, 5000, 5000]) {
    const count = sockets.length;
    sockets.at(-1)?.close();
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(sockets).toHaveLength(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(count + 1);
  }
  connection.close();
});
test("control handshake declares no audio and waits for the authorized snapshot before commands", () => {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const received: unknown[] = [];
  const connection = connectControl({
    location,
    socket: () => socket,
    message: (value) => received.push(value),
    state: () => undefined,
  });
  socket.open();
  expect(socket.sent).toEqual([{ type: "hello", role: "control" }]);
  expect(connection.command({ action: "kill" })).toBe(null);
  socket.receive({ type: "hello", role: "control", audio: false, state: view });
  expect(connection.command({ action: "kill" })).toMatch(/^control-/);
  expect(connection.command({ action: "unmute" })).toMatch(/^control-/);
  expect(socket.sent.at(-1)).toMatchObject({ type: "command", command: { action: "unmute" } });
  expect(connection.tone()).toMatch(/^control-/);
  expect(socket.sent.at(-1)).toMatchObject({ type: "voice_command", mode: "tone" });
  socket.receive({ type: "prepare", take: 1, channel: "main", text: "Synthetic" });
  socket.receive({ type: "hello", role: "control", audio: true, state: view });
  expect(received).toHaveLength(1);
  connection.close();
});

test("reconnect resyncs the snapshot and never resends a previous command", async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const connection = connectControl({
    location,
    socket: () => {
      const value = new FakeSocket();
      sockets.push(value);
      return value;
    },
    message: () => undefined,
    state: (value) => states.push(value),
  });
  const first = sockets[0];
  first?.open();
  first?.receive({ type: "hello", role: "control", audio: false, state: view });
  connection.command({ action: "mute", minutes: 5 });
  first?.close();
  expect(connection.command({ action: "unmute" })).toBe(null);
  await vi.advanceTimersByTimeAsync(999);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);
  sockets[1]?.open();
  expect(sockets[1]?.sent).toEqual([{ type: "hello", role: "control" }]);
  first?.receive({ type: "hello", role: "control", audio: false, state: view });
  expect(states.at(-1)).toBe("connecting");
  connection.close();
  await vi.advanceTimersByTimeAsync(60000);
  expect(sockets).toHaveLength(2);
});

test("a missing authorized hello triggers bounded reconnect instead of permitting commands", async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const connection = connectControl({
    location,
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    message: () => undefined,
    state: () => undefined,
  });
  sockets[0]?.open();
  await vi.advanceTimersByTimeAsync(5000);
  expect(sockets[0]?.readyState).toBe(3);
  await vi.advanceTimersByTimeAsync(1000);
  sockets[1]?.open();
  await vi.advanceTimersByTimeAsync(5000);
  await vi.advanceTimersByTimeAsync(1999);
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(3);
  connection.close();
});
