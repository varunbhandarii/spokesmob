export interface OverlaySocket
  extends Pick<WebSocket, "onopen" | "onmessage" | "onclose" | "onerror"> {
  binaryType: string;
  readyState: number;
  send(value: string): void;
  close(): void;
}
export interface OverlayConnection {
  send(value: unknown): void;
  close(): void;
}

export function connectOverlay(options: {
  location: Pick<Location, "protocol" | "host" | "search">;
  audio: boolean;
  obs: boolean;
  active?: () => boolean;
  message(value: unknown): void | Promise<void>;
  state(state: "connecting" | "connected" | "disconnected"): void;
  disconnect(): void;
  socket?: (url: string) => OverlaySocket;
  clock?: {
    setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  };
}): OverlayConnection {
  const clock = options.clock ?? { setTimeout, clearTimeout };
  const token = new URLSearchParams(options.location.search).get("token");
  if (!token) throw new Error("Overlay authorization is unavailable");
  const endpoint = new URL(
    `${options.location.protocol === "https:" ? "wss:" : "ws:"}//${options.location.host}/ws`,
  );
  endpoint.searchParams.set("token", token);
  let socket: OverlaySocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retry = 0;
  let generation = 0;
  let closed = false;
  let messages = Promise.resolve();
  const send = (value: unknown) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(value));
  };
  const open = () => {
    if (closed) return;
    options.state("connecting");
    const current = ++generation;
    const next: OverlaySocket = options.socket?.(endpoint.toString()) ?? new WebSocket(endpoint);
    next.binaryType = "arraybuffer";
    socket = next;
    next.onopen = () => {
      if (current !== generation || closed) return;
      options.state("connected");
      send({ type: "hello", role: "overlay", audio: options.audio, obs: options.obs });
      send({ type: "active", active: options.active?.() ?? true });
    };
    next.onmessage = (event) => {
      if (current !== generation || closed) return;
      let value: unknown = event.data;
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          return;
        }
      }
      // Serial handling preserves prepare/audio/play ordering while the worklet loads.
      messages = messages
        .then(async () => {
          if (current !== generation || closed) return;
          if (value && typeof value === "object" && "type" in value && value.type === "hello")
            retry = 0;
          await options.message(value);
        })
        .catch(() => {
          options.disconnect();
        });
    };
    next.onerror = () => next.close();
    next.onclose = () => {
      if (current !== generation || closed) return;
      generation++;
      socket = null;
      options.disconnect();
      options.state("disconnected");
      timer = clock.setTimeout(open, Math.min(30000, 1000 * 2 ** Math.min(retry++, 5)));
    };
  };
  open();
  return {
    send,
    close() {
      closed = true;
      generation++;
      if (timer) clock.clearTimeout(timer);
      socket?.close();
      socket = null;
      options.disconnect();
    },
  };
}
