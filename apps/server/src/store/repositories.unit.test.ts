import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveBeatSettings } from "../../../../packages/core/src/beat-settings.js";
import {
  type BeatLogRecord,
  beatLogRecordSchema,
} from "../../../../packages/core/src/beat-types.js";
import { recordedModeration } from "../beat/billing.js";
import { BeatRecords } from "../beat/records.js";
import { systemClock } from "../clock.js";
import { databaseFile, openApplicationStore } from "./application.js";
import { openStorage } from "./db.js";
import { migrate } from "./migrations.js";
import { createRepositories } from "./repositories.js";
import { SpendLedger } from "./spend.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  const db = openStorage(":memory:");
  migrate(db);
  return { db, ...createRepositories(db) };
}
function row(id: string, at: number, e2eMs: number | null = null): BeatLogRecord {
  return beatLogRecordSchema.parse({
    id,
    at,
    kind: "consensus",
    mode: "auto",
    status: "spoken",
    gate: null,
    reason: null,
    line: "Some of chat says blue.",
    dissent: null,
    pct: 60,
    voices: 10,
    mood: "chill",
    citedExemplars: ["blue"],
    citedNames: ["Viewer"],
    latency: {
      assemblyMs: null,
      moderationMs: null,
      modelMs: null,
      verifierMs: null,
      holdMs: null,
      voiceReadyMs: null,
      preRollMs: null,
    },
    e2eMs,
    voiceAttempts: [],
    costUsd: null,
    unknownCost: true,
  });
}

test("migrations are transactional, versioned and repeatable without losing settings", () => {
  const { db, settings } = fixture();
  try {
    settings.set({ minVoices: 1 });
    migrate(db);
    expect(settings.get()).toEqual({ minVoices: 1 });
    expect(db.get("SELECT MAX(version) AS version FROM schema_version")).toEqual({ version: 1 });
    db.run("INSERT INTO schema_version VALUES (?)", 99);
    expect(() => migrate(db)).toThrow("newer");
  } finally {
    db.close();
  }
});

test("late moderation settlement refreshes its original completed beat from the ledger", async () => {
  const f = fixture();
  try {
    const ledger = new SpendLedger(f.costLedger, "session", 5);
    f.beatLog.insert(row("first", 0));
    f.beatLog.insert(row("no-ledger", 0));
    for (const [source, usd] of [
      ["consensus", 0.0007036],
      ["voice", 0.0008544],
    ] as const) {
      const ticket = ledger.reserve(source, 0, "first");
      if (!ticket) throw new Error("Test admission failed");
      ledger.settle(ticket, usd);
    }
    const emitted = vi.fn();
    const records = new BeatRecords(f, "session", emitted, (names) => [...names]);
    let current: string | null = "first";
    let complete!: () => void;
    const port = recordedModeration({
      ledger,
      clock: systemClock,
      beatId: () => current,
      port: {
        moderate: async () => {
          await new Promise<void>((resolve) => {
            complete = resolve;
          });
          return { results: [], usage: null, costUsd: 0 };
        },
      },
      updated: (id) => {
        if (id) records.reconcileCost(id);
      },
    });
    const pending = port.moderate(["blue"]);
    expect(ledger.totals().unknown).toBe(1);
    expect(f.beatLog.get("first")).toMatchObject({ costUsd: null, unknownCost: true });
    current = "next";
    complete();
    await pending;
    expect(ledger.totals().unknown).toBe(0);
    expect(f.beatLog.get("first")).toMatchObject({ costUsd: 0.001558, unknownCost: false });
    expect(emitted).toHaveBeenCalledOnce();
    expect(emitted.mock.calls[0]?.[0]).toMatchObject({
      id: "first",
      costUsd: 0.001558,
      unknownCost: false,
    });
    expect(f.beatLog.reconcileCost("no-ledger")).toBeNull();
    expect(f.beatLog.get("no-ledger")?.unknownCost).toBe(true);
  } finally {
    f.db.close();
  }
});

test("settings, persisted kill and gags survive repository recreation without resetting environment seeds", () => {
  const { db, settings, gags } = fixture();
  try {
    settings.set({ holdMs: 750 });
    settings.setSafety({ muted: true, mutedUntil: null, killed: true });
    settings.setLayout("compact");
    gags.add("viewer'); DROP TABLE settings;--", 1);
    const next = createRepositories(db);
    expect(resolveBeatSettings({ spendCapUsd: 3 }, next.settings.get())).toMatchObject({
      spendCapUsd: 3,
      holdMs: 750,
    });
    expect(next.settings.getSafety()).toEqual({ muted: true, mutedUntil: null, killed: true });
    expect(next.settings.getLayout()).toBe("compact");
    expect(next.gags.list()).toEqual(["viewer'); DROP TABLE settings;--"]);
    next.gags.remove("viewer'); DROP TABLE settings;--");
    expect(gags.list()).toEqual([]);
    expect(() => settings.set({ testOffline: true } as never)).toThrow();
  } finally {
    db.close();
  }
});

test("beat history stores full typed records, updates costs and pages tied timestamps without gaps", () => {
  const { db, beatLog } = fixture();
  try {
    for (let index = 1; index <= 5; index++)
      beatLog.insert(row(String(index), index < 4 ? 1000 : 2000, index * 100));
    expect(beatLog.recent(2).map((item) => item.id)).toEqual(["5", "4"]);
    expect(beatLog.recent(2, "4").map((item) => item.id)).toEqual(["3", "2"]);
    expect(beatLog.recent(2, "2").map((item) => item.id)).toEqual(["1"]);
    expect(beatLog.recent(2, "missing")).toEqual([]);
    beatLog.update("5", { costUsd: 0.01, unknownCost: false });
    expect(beatLog.get("5")).toMatchObject({ costUsd: 0.01, unknownCost: false });
    expect(beatLog.percentiles()).toEqual({ count: 5, p50: 300, p95: 500, max: 500 });
    expect(beatLog.prune(1500)).toBe(3);
    expect(beatLog.recent(10)).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("reservation admission is bounded, unknown stays reserved and late usage updates once", () => {
  const { db, costLedger } = fixture();
  try {
    const ledger = new SpendLedger(costLedger, "session-1", 0.009);
    const voice = ledger.reserve("voice", 100, "beat") as string;
    const model = ledger.reserve("consensus", 101, "beat") as string;
    expect(voice).toBeTruthy();
    expect(model).toBeTruthy();
    expect(ledger.reserve("consensus", 102, "beat")).toBe(null);
    ledger.settle(voice, null);
    expect(ledger.totals()).toMatchObject({ unknown: 2 });
    expect(costLedger.sessionTotal("session-1").usd).toBe(null);
    ledger.settle(voice, 0.001);
    ledger.settle(voice, 0.001);
    ledger.settle(voice, null);
    ledger.settle(model, 0.0001, { inputTokens: 100, outputTokens: 10, cachedTokens: 50 });
    expect(db.get("SELECT usage FROM cost_ledger WHERE id=?", model)?.usage).toBe(
      JSON.stringify({ inputTokens: 100, outputTokens: 10, cachedTokens: 50 }),
    );
    expect(ledger.totals().total).toBeCloseTo(0.0011);
    expect(costLedger.hourly(1000).knownUsd).toBeCloseTo(0.0011);
    expect(costLedger.hourly(1000).unknownCount).toBe(0);
    ledger.reset("session-2");
    expect(ledger.totals().total).toBe(0);
    ledger.settle(voice, 0.002);
    expect(ledger.totals().total).toBe(0);
    expect(costLedger.sessionTotal("session-1").knownUsd).toBeCloseTo(0.0021);
  } finally {
    db.close();
  }
});

test("pruning history cannot erase the active session spend cap", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10 * 86400000);
  const store = openApplicationStore({ tokenFile: "unused", file: ":memory:", retentionDays: 7 });
  try {
    store.beatLog.insert(row("old", 1));
    store.beatLog.insert(row("current", Date.now(), 500));
    const ledger = new SpendLedger(store.costLedger, "session", 0.0085);
    const entry = ledger.reserve("voice", Date.now(), "current") as string;
    store.settings.set({ logRetentionDays: 0 });
    vi.advanceTimersByTime(3600000);
    expect(store.beatLog.recent()).toEqual([]);
    expect(store.costLedger.sessionTotal("session").budgetUsd).toBe(0);
    expect(ledger.totals().reserved).toBe(0.0085);
    expect(ledger.reserve("consensus", Date.now(), "later")).toBe(null);
    ledger.settle(entry, 0.001);
    expect(ledger.totals().total).toBe(0.001);
  } finally {
    store.close();
  }
  expect(vi.getTimerCount()).toBe(0);
});

test("a command cannot raise a run's fixed spend ceiling", () => {
  const { db, costLedger } = fixture();
  try {
    const ledger = new SpendLedger(costLedger, "limited", 5, 0.01);
    expect(ledger.totals().cap).toBe(0.01);
    ledger.setCap(50);
    expect(ledger.totals().cap).toBe(0.01);
    expect(ledger.reserve("voice", 0, null)).not.toBeNull();
    expect(ledger.reserve("voice", 0, null)).toBeNull();
  } finally {
    db.close();
  }
});

test("production database paths default beside tokens and reject repository paths", () => {
  expect(databaseFile(join(tmpdir(), "spokesmob-example", "tokens.json"))).toMatch(
    /spokesmob\.db$/,
  );
  expect(databaseFile("unused", ":memory:")).toBe(":memory:");
  expect(() => databaseFile("unused", "settings.db")).toThrow("outside the repository");
  expect(() => databaseFile("unused", "..settings.db")).toThrow("outside the repository");
  expect(() =>
    openApplicationStore({ tokenFile: "unused", file: ":memory:", retentionDays: 31 }),
  ).toThrow("LOG_RETENTION_DAYS");
});
