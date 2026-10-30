import {
  type ControlAction,
  type ControlMessage,
  controlCommandSchema,
  serverControlMessageSchema,
  voiceCheckCommandSchema,
} from "../../../packages/core/src/overlay-protocol.js";

export interface ControlSocket
  extends Pick<WebSocket, "onopen" | "onmessage" | "onclose" | "onerror"> {
  readyState: number;
  send(value: string): void;
  close(): void;
}
export interface ControlConnection {
  command(value: ControlAction): string | null;
  tone(): string | null;
  close(): void;
}
export function connectControl(options: {
  location: Pick<Location, "protocol" | "host" | "search">;
  message(value: ControlMessage): void;
  state(value: "connecting" | "connected" | "disconnected"): void;
  socket?: (url: string) => ControlSocket;
  clock?: {
    setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
}): ControlConnection {
  const token = new URLSearchParams(options.location.search).get("token");
  if (!token) throw new Error("Control authorization is unavailable");
  const endpoint = new URL(
    `${options.location.protocol === "https:" ? "wss:" : "ws:"}//${options.location.host}/ws`,
  );
  endpoint.searchParams.set("token", token);
  const clock = options.clock ?? {
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
  let socket: ControlSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let handshake: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let retries = 0;
  let sequence = 0;
  let closed = false;
  let welcomed = false;
  const send = (message: unknown) => {
    if (socket?.readyState !== 1 || !welcomed) return false;
    socket.send(JSON.stringify(message));
    return true;
  };
  const open = () => {
    if (closed) return;
    welcomed = false;
    options.state("connecting");
    const current = ++generation;
    const next = options.socket?.(endpoint.toString()) ?? new WebSocket(endpoint);
    socket = next;
    next.onopen = () => {
      if (closed || current !== generation) return;
      next.send(JSON.stringify({ type: "hello", role: "control" }));
      handshake = clock.setTimeout(() => next.close(), 5000);
    };
    next.onmessage = (event) => {
      if (closed || current !== generation || typeof event.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = serverControlMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "hello") {
        welcomed = true;
        retries = 0;
        if (handshake) clock.clearTimeout(handshake);
        handshake = null;
        options.state("connected");
      }
      if (welcomed) options.message(message);
    };
    next.onerror = () => next.close();
    next.onclose = () => {
      if (closed || current !== generation) return;
      generation++;
      welcomed = false;
      socket = null;
      if (handshake) clock.clearTimeout(handshake);
      handshake = null;
      options.state("disconnected");
      timer = clock.setTimeout(open, Math.min(5000, 1000 * 2 ** Math.min(retries++, 3)));
    };
  };
  open();
  return {
    command(command) {
      const request = `control-${++sequence}`;
      const parsed = controlCommandSchema.safeParse({ type: "command", request, command });
      return parsed.success && send(parsed.data) ? request : null;
    },
    tone() {
      const request = `control-${++sequence}`;
      const message = voiceCheckCommandSchema.parse({
        type: "voice_command",
        request,
        mode: "tone",
      });
      return send(message) ? request : null;
    },
    close() {
      closed = true;
      generation++;
      welcomed = false;
      if (timer) clock.clearTimeout(timer);
      if (handshake) clock.clearTimeout(handshake);
      socket?.close();
      socket = null;
    },
  };
}
