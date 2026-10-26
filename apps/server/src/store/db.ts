import { DatabaseSync } from "node:sqlite";

export type StorageValue = null | number | bigint | string | Uint8Array;
export type StorageRow = Record<string, StorageValue>;

export interface StorageChanges {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface Storage {
  exec(sql: string): void;
  run(sql: string, ...parameters: StorageValue[]): StorageChanges;
  get(sql: string, ...parameters: StorageValue[]): StorageRow | undefined;
  all(sql: string, ...parameters: StorageValue[]): StorageRow[];
  close(): void;
}

export function openStorage(path: string): Storage {
  const database = new DatabaseSync(path);
  return {
    exec(sql) {
      database.exec(sql);
    },
    run(sql, ...parameters) {
      return database.prepare(sql).run(...parameters);
    },
    get(sql, ...parameters) {
      return database.prepare(sql).get(...parameters);
    },
    all(sql, ...parameters) {
      return database.prepare(sql).all(...parameters);
    },
    close() {
      database.close();
    },
  };
}
