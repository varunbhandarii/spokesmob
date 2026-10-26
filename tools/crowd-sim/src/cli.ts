import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CrowdOptions,
  generateScenario,
  parseClusters,
  serializeScenario,
} from "./generate.js";

export function parseArguments(args: readonly string[]): { options: CrowdOptions; out?: string } {
  const options: CrowdOptions = {};
  let out: string | undefined;
  const numeric = {
    "--authors": "authors",
    "--rate": "rate",
    "--seconds": "seconds",
    "--seed": "seed",
    "--repeat-share": "repeatShare",
    "--typo-share": "typoShare",
    "--case-share": "caseShare",
    "--emote-share": "emoteShare",
  } as const;
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || value === undefined || value.startsWith("--"))
      throw new Error("Every option needs a value");
    if (name === "--out") out = value;
    else if (name === "--clusters") options.clusters = parseClusters(value);
    else if (name in numeric) options[numeric[name as keyof typeof numeric]] = Number(value);
    else throw new Error("Unknown crowd option");
  }
  return { options, ...(out ? { out } : {}) };
}

async function main(): Promise<void> {
  const { options, out } = parseArguments(process.argv.slice(2));
  const scenario = generateScenario(options);
  const output = serializeScenario(scenario);
  if (out) {
    await writeFile(out, output, "utf8");
    console.log(
      `Wrote ${scenario.lines.length} synthetic messages from ${options.authors ?? 300} authors.`,
    );
  } else process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("Crowd generation failed; check the options and output path.");
    process.exitCode = 1;
  });
}
