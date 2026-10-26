import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openStorage, type Storage } from "./db.js";

test("bound text stays data and rolled-back writes do not persist", () => {
  const storage = openStorage(":memory:");
  try {
    storage.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const value = "blue'); DROP TABLE settings; --";
    const inserted = storage.run("INSERT INTO settings VALUES (?, ?)", "color", value);
    expect(inserted.changes).toBe(1);
    storage.exec("BEGIN");
    storage.run("INSERT INTO settings VALUES (?, ?)", "voice", "cedar");
    storage.exec("ROLLBACK");
    expect(storage.get("SELECT value FROM settings WHERE key = ?", "voice")).toBeUndefined();
    expect(storage.all("SELECT key, value FROM settings")).toEqual([{ key: "color", value }]);
  } finally {
    storage.close();
  }
});

test("stored values survive closing and reopening the database file", () => {
  const directory = mkdtempSync(join(process.cwd(), "storage-test-"));
  const path = join(directory, "settings.db");
  let storage: Storage | undefined;
  try {
    storage = openStorage(path);
    storage.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    storage.run("INSERT INTO settings VALUES (?, ?)", "color", "blue");
    storage.close();
    storage = undefined;
    storage = openStorage(path);
    expect(storage.get("SELECT value FROM settings WHERE key = ?", "color")).toEqual({
      value: "blue",
    });
  } finally {
    storage?.close();
    if (existsSync(path)) unlinkSync(path);
    rmdirSync(directory);
  }
});
