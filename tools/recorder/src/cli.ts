import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadConfig } from "../../../apps/server/src/config.js";
import { createLogger } from "../../../apps/server/src/log.js";
import { anonymizeRecording } from "./anonymize.js";
import { record } from "./record.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const anonymize = args.indexOf("--anonymize");
  if (anonymize >= 0) {
    const input = args[anonymize + 1];
    const output = args[anonymize + 2];
    if (!input || !output || input.startsWith("--") || output.startsWith("--"))
      throw new Error("Provide anonymizer input and output files");
    console.log(
      "Real message text requires each author's consent before publication. Use --replace-text for synthetic text.",
    );
    const result = anonymizeRecording(await readFile(input, "utf8"), {
      replaceText: args.includes("--replace-text"),
    });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, result, { flag: "wx" });
    console.log(`Saved anonymized fixture to ${output}`);
    return;
  }
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const config = loadConfig();
  await record({
    config,
    log: createLogger(config.logLevel),
    minutes: Number(value("--minutes") ?? 2),
    ...(value("--out") ? { out: value("--out") as string } : {}),
  });
}

main().catch(() => {
  console.error("Recorder failed; check configuration, sign-in, arguments and local file paths.");
  process.exitCode = 1;
});
