import type { Storage } from "./db.js";

const migrations = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE beat_log (id TEXT PRIMARY KEY, at INTEGER NOT NULL, record TEXT NOT NULL);
   CREATE INDEX beat_log_time ON beat_log(at DESC, id DESC);
   CREATE TABLE cost_ledger (
     id TEXT PRIMARY KEY, session_id TEXT NOT NULL, at INTEGER NOT NULL,
     source TEXT NOT NULL, beat_id TEXT, usd REAL, reservation REAL NOT NULL, usage TEXT,
     CHECK(reservation >= 0), CHECK(usd IS NULL OR usd >= 0));
   CREATE INDEX cost_ledger_session ON cost_ledger(session_id);
   CREATE INDEX cost_ledger_time ON cost_ledger(at);
   CREATE TABLE gags (user_id TEXT PRIMARY KEY, at INTEGER NOT NULL);`,
] as const;

export function migrate(storage: Storage): void {
  storage.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)");
  const version = Number(
    storage.get("SELECT MAX(version) AS version FROM schema_version")?.version ?? 0,
  );
  if (version > migrations.length)
    throw new Error("Database version is newer than this application");
  for (let index = version; index < migrations.length; index++) {
    storage.exec("BEGIN IMMEDIATE");
    try {
      storage.exec(migrations[index] ?? "");
      storage.run("INSERT INTO schema_version(version) VALUES (?)", index + 1);
      storage.exec("COMMIT");
    } catch {
      storage.exec("ROLLBACK");
      throw new Error("Database migration failed");
    }
  }
}
