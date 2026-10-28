import { fileURLToPath } from "node:url";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { Logger } from "pino";
import { tokenMatches } from "./overlay-token.js";
import { OverlayHub } from "./ws-hub.js";

export async function createHttpServer(options: {
  token: string;
  port: number;
  log?: Pick<Logger, "info">;
  overlayRoot?: string;
  hub?: OverlayHub;
}) {
  // Request URLs carry a credential; automatic request/error logging stays disabled.
  const app = Fastify({ logger: false });
  const hub = options.hub ?? new OverlayHub();
  const port = () => {
    const address = app.server.address();
    return address && typeof address !== "string" ? address.port : options.port;
  };
  const validHost = (host: string | undefined) =>
    host === `127.0.0.1:${port()}` || host === `localhost:${port()}`;
  const validOrigin = (origin: string | undefined) =>
    origin === `http://127.0.0.1:${port()}` || origin === `http://localhost:${port()}`;
  app.addHook("onRequest", async (request, reply) => {
    if (!validHost(request.headers.host)) {
      options.log?.info({ reason: "host" }, "Local request rejected");
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
  });
  await app.register(websocket, { options: { maxPayload: 8000 } });
  await app.register(staticFiles, {
    root: options.overlayRoot ?? fileURLToPath(new URL("../../../overlay/dist/", import.meta.url)),
    prefix: "/overlay/",
    redirect: true,
  });
  app.get("/healthz", async () => ({ ok: true, audioClient: hub.hasAudioClient }));
  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const token = (request.query as { token?: unknown }).token;
        const reason = !validOrigin(request.headers.origin)
          ? "origin"
          : !tokenMatches(options.token, token)
            ? "authorization"
            : null;
        if (reason) {
          options.log?.info({ reason }, "Overlay connection rejected");
          await reply.code(403).send({ error: "Forbidden" });
        }
      },
    },
    (socket) => hub.attach(socket),
  );
  app.setErrorHandler((_error, _request, reply) => {
    void reply.code(500).send({ error: "Local request failed" });
  });
  app.addHook("onClose", async () => hub.close());
  return {
    app,
    hub,
    listen: () => app.listen({ host: "127.0.0.1", port: options.port }),
    close: () => {
      hub.close();
      return app.close();
    },
  };
}
