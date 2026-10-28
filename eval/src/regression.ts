import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { SampleReport } from "./report.js";
import { passesQuality } from "./report.js";

const baselineSchema = z.object({
  aborted: z.string().nullable(),
  samples: z.array(
    z.object({
      id: z.string(),
      sample: z.number().int().positive(),
      tags: z.array(z.string()),
      failures: z.array(
        z.object({
          assertion: z.enum([
            "A1",
            "A2",
            "A3",
            "A4",
            "A5",
            "A6",
            "A7",
            "A8",
            "A9",
            "A10",
            "A11",
            "A12",
          ]),
          code: z.string(),
        }),
      ),
    }),
  ),
});
export type QualityBaseline = z.infer<typeof baselineSchema>;
export interface QualityComparison {
  comparable: boolean;
  pass: boolean | null;
  categories: Record<
    string,
    { baselineRate: number; currentRate: number; deltaPoints: number; pass: boolean }
  >;
}
export async function loadQualityBaseline(path: string): Promise<QualityBaseline> {
  const directory = fileURLToPath(new URL("../reports/", import.meta.url));
  const within = relative(directory, resolve(path));
  if (
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith(`..${sep}`) ||
    !path.endsWith(".json")
  )
    throw new Error("Baseline must be JSON inside eval/reports");
  return baselineSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
}
export function compareQuality(
  baseline: QualityBaseline,
  samples: readonly SampleReport[],
): QualityComparison {
  const keys = (rows: readonly Pick<SampleReport, "id" | "sample">[]) =>
    rows
      .map((row) => `${row.id}:${row.sample}`)
      .sort()
      .join("\n");
  if (baseline.aborted || keys(baseline.samples) !== keys(samples))
    return { comparable: false, pass: null, categories: {} };
  const categories: QualityComparison["categories"] = {};
  for (const tag of [...new Set(baseline.samples.flatMap((sample) => sample.tags))]) {
    const before = baseline.samples.filter((sample) => sample.tags.includes(tag));
    const after = samples.filter((sample) => sample.tags.includes(tag));
    if (keys(before) !== keys(after)) return { comparable: false, pass: null, categories: {} };
    const baselineRate = before.filter(passesQuality).length / before.length;
    const currentRate = after.filter(passesQuality).length / after.length;
    categories[tag] = {
      baselineRate,
      currentRate,
      deltaPoints: (currentRate - baselineRate) * 100,
      pass: currentRate + 0.05 + Number.EPSILON >= baselineRate,
    };
  }
  return { comparable: true, pass: Object.values(categories).every((row) => row.pass), categories };
}
