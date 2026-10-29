import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BeatSettings } from "../../../../packages/core/src/beat-settings.js";
import type { BeatLogRecord, BeatView } from "../../../../packages/core/src/beat-types.js";
import {
  type ControlAction,
  controlActionSchema,
} from "../../../../packages/core/src/overlay-protocol.js";
import type { ActionResult } from "../beat/commands.js";
import type { localAccess } from "./access.js";

export interface ControlApi {
  state(): { state: BeatView; settings: BeatSettings };
  logs(limit: number, before?: string): BeatLogRecord[];
  execute(command: ControlAction): Promise<ActionResult>;
}
const actions = [
  "on",
  "off",
  "speak",
  "veto",
  "mute",
  "unmute",
  "kill",
  "mode",
  "question",
  "clear",
  "settings",
] as const;
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
  names: z.enum(["0", "1"]).optional(),
  before: z.string().min(1).max(200).optional(),
});
export function registerControlApi(
  app: FastifyInstance,
  access: ReturnType<typeof localAccess>,
  api: () => ControlApi | null,
) {
  const guard = async (
    request: Parameters<typeof access.authorize>[0],
    reply: Parameters<typeof access.authorize>[1],
  ) => {
    access.authorize(request, reply);
    if (!reply.sent && !api()) return reply.code(503).send({ error: "Control unavailable" });
  };
  app.get("/api/state", { preHandler: guard }, async () => api()?.state());
  app.get("/api/log", { preHandler: guard }, async (request, reply) => {
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid log query" });
    const query = parsed.data;
    return api()
      ?.logs(query.limit, query.before)
      .map((row) => (query.names === "1" ? row : { ...row, citedNames: [] }));
  });
  for (const action of actions)
    app.post(`/api/${action}`, { preHandler: guard }, async (request, reply) => {
      const body: unknown = request.body ?? {};
      if (!body || typeof body !== "object" || Array.isArray(body) || "action" in body)
        return reply.code(400).send({ error: "Invalid action" });
      const parsed = controlActionSchema.safeParse({ ...body, action });
      if (!parsed.success) return reply.code(400).send({ error: "Invalid action" });
      const result = await api()?.execute(parsed.data);
      return result?.ok ? result : reply.code(422).send(result);
    });
}
