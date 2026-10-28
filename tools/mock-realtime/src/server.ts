import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createMockPeer, type MockClock, type MockRequest } from "./peer.js";
import { BEHAVIORS, type Behavior } from "./script.js";

export async function createRealtimeMock(
  options: {
    port?: number;
    behaviors?: Behavior[];
    clock?: MockClock;
    echo?: (session: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  const queue = [...(options.behaviors ?? [])];
  const requests: MockRequest[] = [];
  const sockets = new Set<WebSocket>();
  const peers = new Set<ReturnType<typeof createMockPeer>>();
  let connections = 0;
  const http = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, connections, queued: queue.length }));
      return;
    }
    if (request.method === "POST" && request.url === "/control") {
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 4096) throw new Error("Too large");
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { behavior?: unknown };
        if (!BEHAVIORS.includes(body.behavior as Behavior)) throw new Error("Unknown behavior");
        queue.push(body.behavior as Behavior);
        response.writeHead(204);
        response.end();
        return;
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
    }
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({ server: http, path: "/realtime", maxPayload: 64_000 });
  wss.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    const peer = createMockPeer({
      send: (event) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      },
      disconnect: () => socket.close(1011, "Synthetic transport failure"),
      nextBehavior: () => queue.shift() ?? "normal",
      requests,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.echo ? { echo: options.echo } : {}),
    });
    peers.add(peer);
    socket.on("message", (data) => {
      try {
        peer.receive(JSON.parse(data.toString()));
      } catch {
        socket.close(1003);
      }
    });
    socket.on("close", () => {
      peer.close();
      peers.delete(peer);
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Mock has no TCP address");
  return {
    url: `ws://127.0.0.1:${address.port}/realtime`,
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    get connections() {
      return connections;
    },
    enqueue: (...behaviors: Behavior[]) => queue.push(...behaviors),
    inject: (event: Record<string, unknown>) => {
      for (const peer of peers) peer.inject(event);
    },
    close: async () => {
      for (const peer of peers) peer.close();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
