import { expect, test } from "vitest";
import {
  beatSettingsPatchSchema,
  beatSettingsSchema,
  DEFAULT_BEAT_SETTINGS,
  resolveBeatSettings,
} from "./beat-settings.js";

test("beat settings pin defaults and stored values override environment seeds", () => {
  expect(beatSettingsSchema.parse({})).toEqual({
    splitVotes: true,
    autoClip: true,
    mode: "auto",
    windowS: 8,
    minVoices: 2,
    holdMs: 1000,
    cooldownS: 2,
    pinS: 60,
    postLines: "every",
    spendCapUsd: 5,
    muteDefaultMin: 5,
    logRetentionDays: 7,
  });
  expect(Object.isFrozen(DEFAULT_BEAT_SETTINGS)).toBe(true);
  expect(resolveBeatSettings({ minVoices: 1, spendCapUsd: 3 }, { minVoices: 4 })).toEqual({
    ...DEFAULT_BEAT_SETTINGS,
    minVoices: 4,
    spendCapUsd: 3,
  });
  expect(resolveBeatSettings({ minVoices: 1 }, { minVoices: undefined }).minVoices).toBe(1);
  expect(beatSettingsPatchSchema.parse({ holdMs: 750 })).toEqual({ holdMs: 750 });
});

test.each([
  { windowS: 4.99 },
  { windowS: 20.01 },
  { minVoices: 0 },
  { minVoices: 11 },
  { minVoices: 1.5 },
  { holdMs: 499 },
  { holdMs: 3001 },
  { cooldownS: -1 },
  { cooldownS: 11 },
  { pinS: 29 },
  { pinS: 1801 },
  { spendCapUsd: -1 },
  { spendCapUsd: Number.POSITIVE_INFINITY },
  { muteDefaultMin: 0 },
  { muteDefaultMin: 61 },
  { logRetentionDays: -1 },
  { logRetentionDays: 31 },
  { mode: "other" },
  { postLines: "sometimes" },
  { testOffline: true },
  { token: "synthetic" },
])("beat settings reject invalid bounds and unsupported fields: %j", (value) => {
  expect(beatSettingsSchema.safeParse(value).success).toBe(false);
  expect(beatSettingsPatchSchema.safeParse(value).success).toBe(false);
});

test("zero cooldown, zero cap and zero retention remain valid explicit settings", () => {
  expect(
    beatSettingsSchema.parse({ cooldownS: 0, spendCapUsd: 0, logRetentionDays: 0 }),
  ).toMatchObject({
    cooldownS: 0,
    spendCapUsd: 0,
    logRetentionDays: 0,
  });
});
