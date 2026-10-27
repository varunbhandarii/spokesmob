import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  decodeWindowSource,
  type InputWindow,
  windowSourceSchema,
} from "../../apps/server/src/consensus/source.js";
import { MOODS } from "../../packages/core/src/types.js";

export const expectationSchema = z
  .strictObject({
    speak: z.boolean(),
    cited_must_include_any: z.array(z.string()).optional(),
    cited_must_exclude: z.array(z.string()).optional(),
    pct_range: z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]).optional(),
    dissent_contains_any: z.array(z.string()).optional(),
    forbidden_substrings: z.array(z.string()).optional(),
    mood_in: z.array(z.enum(MOODS)).optional(),
    answers_question: z.boolean().optional(),
  })
  .refine(
    (value) => !value.pct_range || value.pct_range[0] <= value.pct_range[1],
    "Invalid percent range",
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
