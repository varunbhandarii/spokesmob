import { z } from "zod";
import { beatSettingsSchema } from "../../../packages/core/src/beat-settings.js";
import {
  type BeatLogRecord,
  beatLogRecordSchema,
  beatViewSchema,
} from "../../../packages/core/src/beat-types.js";
import { voteSnapshotSchema } from "../../../packages/core/src/overlay-protocol.js";
import { LOG_LIMIT } from "./model.js";

const snapshotSchema = z.strictObject({
  state: beatViewSchema,
  settings: beatSettingsSchema,
  vote: voteSnapshotSchema.nullable().optional(),
});
const logPageSchema = z.array(beatLogRecordSchema).max(LOG_LIMIT);
export function createControlApi(options: {
  location: Pick<Location, "protocol" | "host" | "search">;
  fetch?: typeof fetch;
}) {
  const token = new URLSearchParams(options.location.search).get("token");
  if (!token) throw new Error("Control authorization is unavailable");
  const request = options.fetch ?? fetch;
  const origin = `${options.location.protocol}//${options.location.host}`;
  async function get(path: string): Promise<unknown> {
    const response = await request(new URL(path, origin), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Control request unavailable");
    return response.json();
  }
  return {
    async state() {
      return snapshotSchema.parse(await get("/api/state"));
    },
    async logs(before?: string) {
      const query = new URLSearchParams({ limit: String(LOG_LIMIT), names: "1" });
      if (before) query.set("before", before);
      return logPageSchema.parse(await get(`/api/log?${query}`));
    },
    async recent() {
      return logPageSchema.parse(await get(`/api/log?limit=${LOG_LIMIT}`));
    },
  };
}

export async function collectLog(
  page: (before?: string) => Promise<BeatLogRecord[]>,
  options: { findId?: string; maxRows?: number; maxCharacters?: number } = {},
): Promise<BeatLogRecord[]> {
  const maxRows = options.maxRows ?? 100000;
  const maxCharacters = options.maxCharacters ?? 25000000;
  const rows: BeatLogRecord[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let before: string | undefined;
  let characters = 0;
  for (;;) {
    const batch = await page(before);
    for (const row of batch) {
      if (seen.has(row.id)) throw new Error("Log pagination did not advance");
      seen.add(row.id);
      rows.push(row);
      characters += JSON.stringify(row).length;
      if (rows.length > maxRows || characters > maxCharacters)
        throw new Error("Log export is too large");
      if (row.id === options.findId) return rows;
    }
    if (batch.length < LOG_LIMIT) return rows;
    before = batch.at(-1)?.id;
    if (!before || cursors.has(before)) throw new Error("Log pagination did not advance");
    cursors.add(before);
  }
}
