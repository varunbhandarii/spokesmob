import type { FastifyReply, FastifyRequest } from "fastify";
import { tokenMatches } from "./overlay-token.js";

export function localAccess(token: string, port: () => number) {
  const host = (value: string | undefined) =>
    value === `127.0.0.1:${port()}` || value === `localhost:${port()}`;
  const origin = (value: string | undefined) =>
    value === `http://127.0.0.1:${port()}` || value === `http://localhost:${port()}`;
  return {
    host,
    origin,
    authorize(request: FastifyRequest, reply: FastifyReply) {
      const bearer = request.headers.authorization?.match(/^Bearer (\S+)$/u)?.[1];
      const queryToken = (request.query as { token?: unknown }).token;
      if (
        !host(request.headers.host) ||
        ((request.method === "POST" || request.headers.origin !== undefined) &&
          !origin(request.headers.origin)) ||
        !tokenMatches(token, bearer ?? queryToken)
      )
        return reply.code(403).send({ error: "Forbidden" });
    },
  };
}
