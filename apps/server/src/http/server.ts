import { fileURLToPath } from "node:url";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { Logger } from "pino";
import { localAccess } from "./access.js";
import { type ControlApi, registerControlApi } from "./api.js";
import { tokenMatches } from "./overlay-token.js";
import { OverlayHub } from "./ws-hub.js";

export async function createHttpServer(options: {
  token: string;
  port: number;
  log?: Pick<Logger, "info">;
  overlayRoot?: string;
  controlRoot?: string;
  hub?: OverlayHub;
}) {
  // Request URLs carry a credential; automatic request/error logging stays disabled.
  const app = Fastify({ logger: false });
  const hub = options.hub ?? new OverlayHub();
  const port = () => {
    const address = app.server.address();
    return address && typeof address !== "string" ? address.port : options.port;
  };
  const access = localAccess(options.token, port);
  let control: ControlApi | null = null;
  app.addHook("onRequest", async (request, reply) => {
    if (!access.host(request.headers.host)) {
      options.log?.info({ reason: "host" }, "Local request rejected");
      return reply.code(403).send({ error: "Forbidden" });
    }
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `connect-src 'self' ws://127.0.0.1:${port()} ws://localhost:${port()}`,
        "img-src 'self' data:",
        "font-src 'self'",
        "script-src 'self'",
        "worker-src 'self'",
        "style-src 'self'",
      ].join("; "),
    );
  });
  await app.register(websocket, { options: { maxPayload: 8000 } });
  await app.register(staticFiles, {
    root: options.overlayRoot ?? fileURLToPath(new URL("../../../overlay/dist/", import.meta.url)),
    prefix: "/overlay/",
    redirect: true,
  });
  await app.register(staticFiles, {
    root: options.controlRoot ?? fileURLToPath(new URL("../../../control/dist/", import.meta.url)),
    prefix: "/control/",
    redirect: true,
    decorateReply: false,
  });
  registerControlApi(app, access, () => control);
  app.get("/healthz", async () => ({ ok: true, audioClient: hub.hasAudioClient }));
  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        const token = (request.query as { token?: unknown }).token;
        const reason = !access.origin(request.headers.origin)
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
  app.setErrorHandler((error, _request, reply) => {
    const code =
      error && typeof error === "object" && "statusCode" in error ? error.statusCode : null;
    const status = code === 400 || code === 413 ? code : 500;
    void reply.code(status).send({ error: "Local request failed" });
  });
  app.addHook("onClose", async () => hub.close());
  return {
    app,
    hub,
    setControl(api: ControlApi) {
      control = api;
    },
    listen: () => app.listen({ host: "127.0.0.1", port: options.port }),
    close: () => {
      hub.close();
      return app.close();
    },
  };
}
