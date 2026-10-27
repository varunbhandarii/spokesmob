import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  decodeWindowSource,
  type InputWindow,
  windowSourceSchema,
} from "../../apps/server/src/consensus/source.js";
import { ruleCodeSchema } from "../../packages/core/src/schema.js";
import { MOODS } from "../../packages/core/src/types.js";

export const expectationSchema = z
  .strictObject({
    speak: z.union([z.boolean(), z.literal("either")]),
    safety_only: z.boolean().optional(),
    suppression_reasons: z.array(ruleCodeSchema).min(1).optional(),
    cited_must_include_any: z.array(z.string()).optional(),
    cited_must_exclude: z.array(z.string()).optional(),
    pct_range: z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]).optional(),
    pct_values: z.array(z.number().min(0).max(100)).min(1).optional(),
    dissent_contains_any: z.array(z.string()).optional(),
    forbidden_text: z.array(z.string()).optional(),
    quoted_source_any: z.array(z.string()).optional(),
    mood_in: z.array(z.enum(MOODS)).optional(),
    answers_question: z.boolean().optional(),
  })
  .refine(
    (value) => !value.pct_range || value.pct_range[0] <= value.pct_range[1],
    "Invalid percent range",
  )
  .refine(
    (value) => !(value.pct_range && value.pct_values),
    "Choose a percent range or discrete values",
  )
  .refine(
    (value) =>
      !value.safety_only ||
      (value.speak === "either" &&
        value.pct_range === undefined &&
        value.pct_values === undefined &&
        value.cited_must_include_any === undefined &&
        value.cited_must_exclude === undefined &&
        value.answers_question === undefined &&
        value.dissent_contains_any === undefined &&
        value.mood_in === undefined),
    "Safety-only cases cannot impose quality targets",
  );
export const goldenSchema = windowSourceSchema.and(
  z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    tags: z.array(z.string()).min(1),
    question: z.string().nullable(),
    persona: z.literal("deadpan"),
    expect: expectationSchema,
  }),
);
export interface GoldenWindow extends InputWindow {
  id: string;
  tags: string[];
  question: string | null;
  expect: z.infer<typeof expectationSchema>;
}
export function parseGolden(raw: unknown): GoldenWindow {
  const parsed = goldenSchema.parse(raw);
  return {
    ...decodeWindowSource(parsed),
    id: parsed.id,
    tags: parsed.tags,
    question: parsed.question,
    expect: parsed.expect,
  };
}
export const goldenDirectory = fileURLToPath(new URL("../golden/", import.meta.url));
export async function loadGoldens(directory = goldenDirectory): Promise<GoldenWindow[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const windows = await Promise.all(
    names.map(async (name) =>
      parseGolden(JSON.parse(await readFile(resolve(directory, name), "utf8"))),
    ),
  );
  if (new Set(windows.map((window) => window.id)).size !== windows.length)
    throw new Error("Golden names must be unique");
  return windows;
}
