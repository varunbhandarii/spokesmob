import { z } from "zod";
import {
  type BeatSettingsPatch,
  beatSettingsPatchSchema,
} from "../../../../packages/core/src/beat-settings.js";
import {
  type BeatLogRecord,
  beatLogRecordSchema,
  layoutSchema,
} from "../../../../packages/core/src/beat-types.js";
import type { Storage, StorageRow } from "./db.js";

const tokens = z.number().int().nonnegative();
export const ledgerUsageSchema = z.union([
  z.strictObject({
    inputTokens: tokens,
    outputTokens: tokens,
    cachedTokens: tokens,
    cacheWriteTokens: tokens.optional(),
  }),
  z.strictObject({
    textInputTokens: tokens,
    cachedTextInputTokens: tokens,
    textOutputTokens: tokens,
    audioOutputTokens: tokens,
    reasoningTokens: tokens.nullable(),
  }),
]);
export type LedgerUsage = z.infer<typeof ledgerUsageSchema>;

const safetySchema = z
  .strictObject({
    muted: z.boolean(),
    mutedUntil: z.number().nonnegative().nullable(),
    killed: z.boolean(),
  })
  .refine(
    (value) =>
      (!value.killed || (value.muted && value.mutedUntil === null)) &&
      (value.muted || value.mutedUntil === null),
  );
export type SafetySettings = z.infer<typeof safetySchema>;
function json<T>(raw: unknown, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(String(raw)));
  } catch {
    throw new Error("Stored data is invalid");
  }
}
const serialize = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item === Number.NEGATIVE_INFINITY ? "-Infinity" : item,
  );
function percentile(values: number[], share: number): number | null {
  if (!values.length) return null;
  return values.slice().sort((a, b) => a - b)[Math.ceil(values.length * share) - 1] ?? null;
}

export function createRepositories(storage: Storage) {
  const setting = (key: string, value: unknown) =>
    storage.run(
      "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      serialize(value),
    );
  const settings = {
    get(): BeatSettingsPatch {
      const row = storage.get("SELECT value FROM settings WHERE key=?", "loop");
      return row ? json(row.value, beatSettingsPatchSchema) : {};
    },
    set(changes: BeatSettingsPatch): void {
      const value = beatSettingsPatchSchema.parse({ ...settings.get(), ...changes });
      setting("loop", value);
    },
    list() {
      return {
        settings: settings.get(),
        safety: settings.getSafety(),
        layout: settings.getLayout(),
      };
    },
    getSafety(): SafetySettings {
      const row = storage.get("SELECT value FROM settings WHERE key=?", "safety");
      return row
        ? json(row.value, safetySchema)
        : { muted: false, mutedUntil: null, killed: false };
    },
    setSafety(value: SafetySettings): void {
      setting("safety", safetySchema.parse(value));
    },
    getLayout() {
      const row = storage.get("SELECT value FROM settings WHERE key=?", "layout");
      return row ? json(row.value, layoutSchema) : ("wide" as const);
    },
    setLayout(value: z.infer<typeof layoutSchema>) {
      setting("layout", layoutSchema.parse(value));
    },
  };
  const beatLog = {
    reconcileCost(id: string): BeatLogRecord | null {
      const previous = beatLog.get(id);
      if (!previous) return null;
      if (!storage.get("SELECT 1 AS present FROM cost_ledger WHERE beat_id=? LIMIT 1", id))
        return null;
      const costs = costLedger.beatTotal(id);
      const unknownCost = costs.unknownCount > 0;
      if (previous.costUsd === costs.usd && previous.unknownCost === unknownCost) return null;
      const row = { ...previous, costUsd: costs.usd, unknownCost };
      beatLog.update(id, row);
      return row;
    },
    insert(record: BeatLogRecord): void {
      const value = beatLogRecordSchema.parse(record);
      storage.run(
        "INSERT INTO beat_log(id,at,record) VALUES (?,?,?)",
        value.id,
        value.at,
        serialize(value),
      );
    },
    get(id: string): BeatLogRecord | null {
      const row = storage.get("SELECT record FROM beat_log WHERE id=?", id);
      return row ? json(row.record, beatLogRecordSchema) : null;
    },
    update(id: string, changes: Partial<BeatLogRecord>): void {
      const previous = beatLog.get(id);
      if (!previous) return;
      const next = beatLogRecordSchema.parse({ ...previous, ...changes, id });
      storage.run("UPDATE beat_log SET at=?, record=? WHERE id=?", next.at, serialize(next), id);
    },
    recent(limit = 50, before?: string): BeatLogRecord[] {
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new RangeError("Log limit must be 1 to 1000");
      const cursor = before ? beatLog.get(before) : null;
      if (before && !cursor) return [];
      const rows = cursor
        ? storage.all(
            "SELECT record FROM beat_log WHERE at < ? OR (at=? AND id < ?) ORDER BY at DESC,id DESC LIMIT ?",
            cursor.at,
            cursor.at,
            cursor.id,
            limit,
          )
        : storage.all("SELECT record FROM beat_log ORDER BY at DESC,id DESC LIMIT ?", limit);
      return rows.map((row) => json(row.record, beatLogRecordSchema));
    },
    percentiles() {
      const values = storage
        .all("SELECT record FROM beat_log")
        .map((row) => json(row.record, beatLogRecordSchema))
        .flatMap((row) => (row.e2eMs === null ? [] : [row.e2eMs]));
      return {
        count: values.length,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        max: values.length ? Math.max(...values) : null,
      };
    },
    prune(before: number): number {
      return Number(storage.run("DELETE FROM beat_log WHERE at < ?", before).changes);
    },
  };
  const costEntrySchema = z.strictObject({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    at: z.number().nonnegative(),
    source: z.enum(["consensus", "voice", "moderation"]),
    beatId: z.string().nullable(),
    usd: z.number().nonnegative().nullable(),
    reservation: z.number().nonnegative(),
    usage: ledgerUsageSchema.nullable().optional(),
  });
  type CostEntry = z.infer<typeof costEntrySchema>;
  function total(rows: StorageRow[]) {
    let knownUsd = 0;
    let reservedUsd = 0;
    let unknownCount = 0;
    for (const row of rows) {
      const parsed = z
        .object({ usd: z.number().nonnegative().nullable(), reservation: z.number().nonnegative() })
        .safeParse(row);
      if (!parsed.success) throw new Error("Stored cost data is invalid");
      if (parsed.data.usd === null) {
        reservedUsd += parsed.data.reservation;
        unknownCount++;
      } else knownUsd += parsed.data.usd;
    }
    return {
      knownUsd,
      reservedUsd,
      budgetUsd: knownUsd + reservedUsd,
      unknownCount,
      usd: unknownCount ? null : knownUsd,
    };
  }
  const costLedger = {
    add(input: CostEntry): void {
      const entry = costEntrySchema.parse(input);
      storage.run(
        "INSERT INTO cost_ledger(id,session_id,at,source,beat_id,usd,reservation,usage) VALUES (?,?,?,?,?,?,?,?)",
        entry.id,
        entry.sessionId,
        entry.at,
        entry.source,
        entry.beatId,
        entry.usd,
        entry.reservation,
        entry.usage ? serialize(entry.usage) : null,
      );
    },
    update(id: string, usd: number | null, usage?: LedgerUsage | null): void {
      z.number().nonnegative().nullable().parse(usd);
      if (usd !== null) storage.run("UPDATE cost_ledger SET usd=? WHERE id=?", usd, id);
      if (usage)
        storage.run(
          "UPDATE cost_ledger SET usage=? WHERE id=?",
          serialize(ledgerUsageSchema.parse(usage)),
          id,
        );
    },
    sessionTotal(sessionId: string) {
      return total(
        storage.all("SELECT usd,reservation FROM cost_ledger WHERE session_id=?", sessionId),
      );
    },
    beatTotal(beatId: string) {
      return total(storage.all("SELECT usd,reservation FROM cost_ledger WHERE beat_id=?", beatId));
    },
    hourly(now: number) {
      return total(
        storage.all(
          "SELECT usd,reservation FROM cost_ledger WHERE at>=? AND at<=?",
          now - 3600000,
          now,
        ),
      );
    },
    prune(before: number): number {
      return Number(storage.run("DELETE FROM cost_ledger WHERE at < ?", before).changes);
    },
  };
  const gags = {
    add(userId: string, at: number): void {
      if (!userId) throw new Error("User ID is required");
      storage.run(
        "INSERT INTO gags(user_id,at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET at=excluded.at",
        userId,
        at,
      );
    },
    remove(userId: string): void {
      storage.run("DELETE FROM gags WHERE user_id=?", userId);
    },
    list(): string[] {
      return storage
        .all("SELECT user_id FROM gags ORDER BY user_id")
        .map((row) => String(row.user_id));
    },
  };
  return { settings, beatLog, costLedger, gags };
}
export type Repositories = ReturnType<typeof createRepositories>;
