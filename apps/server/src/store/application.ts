import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Clock, systemClock } from "../clock.js";
import { openStorage } from "./db.js";
import { migrate } from "./migrations.js";
import { createRepositories } from "./repositories.js";

export function databaseFile(tokenFile: string, override?: string): string {
  if (override === ":memory:") return override;
  const path = resolve(override ?? join(dirname(tokenFile), "spokesmob.db"));
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const within = relative(root, path);
  if (!within || (within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within)))
    throw new Error("DB_FILE must stay outside the repository");
  return path;
}

export function openApplicationStore(options: {
  tokenFile: string;
  file?: string;
  retentionDays?: number;
  clock?: Clock;
}) {
  const path = databaseFile(options.tokenFile, options.file ?? process.env.DB_FILE);
  const retentionDays = options.retentionDays ?? Number(process.env.LOG_RETENTION_DAYS ?? 7);
  if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 30)
    throw new Error("LOG_RETENTION_DAYS must be an integer from 0 to 30");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const storage = openStorage(path);
  try {
    migrate(storage);
  } catch (error) {
    storage.close();
    throw error;
  }
  const repositories = createRepositories(storage);
  const clock = options.clock ?? systemClock;
  const prune = () => {
    const days = repositories.settings.get().logRetentionDays ?? retentionDays;
    const before = clock.now() - days * 86400000;
    return {
      beats: repositories.beatLog.prune(before),
      costs: repositories.costLedger.prune(before),
    };
  };
  try {
    prune();
    const timer = clock.setInterval(prune, 3600000);
    return {
      ...repositories,
      path,
      prune,
      close() {
        clock.clearInterval(timer);
        storage.close();
      },
    };
  } catch (error) {
    storage.close();
    throw error;
  }
}
