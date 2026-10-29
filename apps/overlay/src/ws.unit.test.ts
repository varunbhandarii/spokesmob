import { afterEach, expect, test, vi } from "vitest";
import { connectOverlay, type OverlaySocket } from "./ws.js";

afterEach(() => vi.useRealTimers());
class FakeSocket implements OverlaySocket {
  binaryType = "";
  readyState = 1;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
test("socket reconnects with bounded backoff and repeats the hello handshake", async () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  const states: string[] = [];
  const disconnect = vi.fn();
  const connection = connectOverlay({
    location: { protocol: "http:", host: "127.0.0.1:4040", search: "?token=synthetic" },
    audio: true,
    obs: true,
    state: (state) => states.push(state),
    disconnect,
    message: () => undefined,
    socket: (url) => {
      expect(new URL(url).pathname).toBe("/ws");
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  sockets[0]?.onopen?.();
  expect(sockets[0]?.sent).toEqual([
    { type: "hello", role: "overlay", audio: true, obs: true },
    { type: "active", active: true },
  ]);
  sockets[0]?.close();
  await vi.advanceTimersByTimeAsync(999);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);
  sockets[1]?.onopen?.();
  expect(sockets[1]?.sent).toHaveLength(2);
  connection.close();
  await vi.advanceTimersByTimeAsync(60000);
  expect(sockets).toHaveLength(2);
  expect(disconnect).toHaveBeenCalled();
  expect(states).toContain("disconnected");
});
test("messages preserve order and disconnected generations discard queued events", async () => {
  const socket = new FakeSocket();
  const received: unknown[] = [];
  const connection = connectOverlay({
    location: { protocol: "http:", host: "localhost:4040", search: "?token=synthetic" },
    audio: false,
    obs: false,
    state: () => undefined,
    disconnect: () => undefined,
    socket: () => socket,
    message: async (value) => {
      received.push(value);
    },
  });
  socket.onmessage?.({ data: JSON.stringify({ type: "prepare", take: 1 }) });
  socket.onmessage?.({ data: new ArrayBuffer(11) });
  for (let index = 0; index < 10; index++) await Promise.resolve();
  expect(received).toHaveLength(2);
  socket.onmessage?.({ data: "{broken" });
  expect(received).toHaveLength(2);
  socket.onmessage?.({ data: "{}" });
  connection.close();
  await Promise.resolve();
  expect(received).toHaveLength(2);
});
