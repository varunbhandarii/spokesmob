import { z } from "zod";

export const beatModeSchema = z.enum(["auto", "demand", "quiet"]);
export type BeatMode = z.infer<typeof beatModeSchema>;
const fields = {
  mode: beatModeSchema,
  windowS: z.number().min(5).max(20),
  minVoices: z.number().int().min(1).max(10),
  holdMs: z.number().int().min(500).max(3000),
  cooldownS: z.number().min(0).max(10),
  pinS: z.number().int().min(30).max(1800),
  postLines: z.enum(["every", "off"]),
  spendCapUsd: z.number().nonnegative(),
  muteDefaultMin: z.number().int().min(1).max(60),
  logRetentionDays: z.number().int().min(0).max(30),
};
export const beatSettingsSchema = z.strictObject({
  mode: fields.mode.default("auto"),
  windowS: fields.windowS.default(8),
  minVoices: fields.minVoices.default(2),
  holdMs: fields.holdMs.default(1000),
  cooldownS: fields.cooldownS.default(2),
  pinS: fields.pinS.default(60),
  postLines: fields.postLines.default("every"),
  spendCapUsd: fields.spendCapUsd.default(5),
  muteDefaultMin: fields.muteDefaultMin.default(5),
  logRetentionDays: fields.logRetentionDays.default(7),
});
export type BeatSettings = z.infer<typeof beatSettingsSchema>;
export const beatSettingsPatchSchema = z.strictObject(fields).partial();
export type BeatSettingsPatch = z.infer<typeof beatSettingsPatchSchema>;
export const DEFAULT_BEAT_SETTINGS: Readonly<BeatSettings> = Object.freeze(
  beatSettingsSchema.parse({}),
);

export function resolveBeatSettings(seed: unknown = {}, stored: unknown = {}): BeatSettings {
  const defined = (value: unknown) =>
    Object.fromEntries(
      Object.entries(beatSettingsPatchSchema.parse(value)).filter(([, item]) => item !== undefined),
    );
  return beatSettingsSchema.parse({ ...defined(seed), ...defined(stored) });
}
