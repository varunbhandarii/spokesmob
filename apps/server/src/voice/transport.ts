import { OpenAIRealtimeWS } from "openai/realtime/ws";
import type { RealtimeClientEvent } from "openai/resources/realtime/realtime";
import { WebSocket } from "ws";

export interface RealtimeListeners {
  open(): void;
  event(event: unknown): void;
  error(): void;
  close(): void;
}
export interface RealtimeTransport {
  send(event: RealtimeClientEvent): void;
  close(): void;
}
export type RealtimeFactory = (listeners: RealtimeListeners) => RealtimeTransport;

export function realtimeFactory(apiKey: string, localUrl?: string): RealtimeFactory {
  if (localUrl) {
    const url = new URL(localUrl);
    if (
      !/^wss?:$/.test(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error("OPENAI_REALTIME_URL must be a loopback WebSocket URL");
    // The mock transport deliberately sends no API credentials.
    return (listeners) => {
      const socket = new WebSocket(url, { maxPayload: 2_000_000, perMessageDeflate: false });
      socket.on("open", listeners.open);
      socket.on("message", (data) => {
        try {
          listeners.event(JSON.parse(data.toString()));
        } catch {
          listeners.error();
        }
      });
      socket.on("error", listeners.error);
      socket.on("close", listeners.close);
      return {
        send: (event) => socket.send(JSON.stringify(event)),
        close: () => {
          if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
          else socket.close();
        },
      };
    };
  }
  return (listeners) => {
    const rt = new OpenAIRealtimeWS(
      { model: "gpt-realtime-2.1-mini", options: { maxPayload: 2_000_000 } },
      { apiKey, baseURL: "https://api.openai.com/v1" },
    );
    rt.socket.on("open", listeners.open);
    rt.on("event", listeners.event);
    rt.on("error", listeners.error);
    rt.socket.on("close", listeners.close);
    return {
      send: (event) => rt.send(event),
      close: () => {
        if (rt.socket.readyState === WebSocket.CONNECTING) rt.socket.terminate();
        else rt.close();
      },
    };
  };
}
