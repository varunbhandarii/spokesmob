import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { OpenAI } from "openai";
import { createBlocklist } from "../../../../packages/core/src/blocklist.js";
import { parseScenario } from "../../../../tools/mock-eventsub/src/scenario.js";
import { loadOpenAIConfig, requireOpenAIKey } from "../config.js";
import { FakeModerationPort } from "../consensus/fakes.js";
import { OpenAIConsensusModel, OpenAIModerationPort } from "../consensus/model.js";
import { ModerationGate } from "../consensus/moderation.js";
import { decodeWindowSource, scenarioWindows } from "../consensus/source.js";
import { StubConsensusModel } from "../consensus/stub-model.js";
import { synthesize } from "../consensus/synthesize.js";

async function inputPath(name: string): Promise<string> {
  for (const path of [
    resolve(name),
    resolve("tools/mock-eventsub/scenarios", `${name}.jsonl`),
    resolve("eval/golden", `${name}.json`),
  ]) {
    try {
      await access(path);
      return path;
    } catch {
      /* Try the next supported input location. */
    }
  }
  throw new Error("Consensus input was not found");
}
export async function consensusCheck(
  options: { args?: string[]; output?: (line: string) => void } = {},
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: options.args ?? process.argv.slice(2),
    allowPositionals: true,
    options: {
      window: { type: "string", default: "8" },
      question: { type: "string" },
      live: { type: "boolean" },
      tier: { type: "string" },
      "count-prefix": { type: "boolean" },
    },
  });
  const seconds = Number(values.window);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 120)
    throw new Error("Window must be from 1 to 120 seconds");
  const config = loadOpenAIConfig();
  const tier = values.tier ?? config.serviceTier;
  if (tier !== "default" && tier !== "fast") throw new Error("Tier must be default or fast");
  const output = options.output ?? console.log;
  const client =
    values.live || values["count-prefix"]
      ? new OpenAI({ apiKey: requireOpenAIKey(config), maxRetries: 0 })
      : null;
  const model = client
    ? new OpenAIConsensusModel({ client, serviceTier: tier })
    : new StubConsensusModel();
  if (values["count-prefix"]) {
    if (!(model instanceof OpenAIConsensusModel))
      throw new Error("Prefix counting needs the API adapter");
    const result = await model.countPrefix();
    output(JSON.stringify({ kind: "prefix", ...result, cacheEligible: result.tokens >= 1024 }));
    if (result.tokens < 1024) throw new Error("Static prefix is below the cache threshold");
    return;
  }
  if (positionals.length !== 1) throw new Error("Provide one scenario or golden input");
  if (!values.live) output("OFFLINE: unmoderated test output; not for streaming. No API calls.");
  const path = await inputPath(positionals[0] ?? "");
  const text = await readFile(path, "utf8");
  const raw: unknown = path.endsWith(".jsonl") ? null : JSON.parse(text);
  const windows =
    raw === null ? scenarioWindows(parseScenario(text), seconds) : [decodeWindowSource(raw)];
  const question =
    values.question ??
    (typeof raw === "object" &&
    raw !== null &&
    "question" in raw &&
    typeof raw.question === "string"
      ? raw.question
      : null);
  const port = client ? new OpenAIModerationPort(client) : new FakeModerationPort();
  const gate = new ModerationGate({ port });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let previousLine: string | null = null;
  try {
    for (const [index, window] of windows.entries()) {
      const result = await synthesize({
        ...window,
        question,
        previousLine,
        minVoices: config.minVoices,
        moderation: gate,
        outputModeration: port,
        model,
        blocklist: createBlocklist(),
        serviceTier: tier,
        signal: controller.signal,
      });
      if (result.status === "verified") previousLine = result.line;
      output(
        JSON.stringify({
          window: index + 1,
          ...result,
          ...(window.encoded
            ? {
                line: result.line ? "[encoded fixture output withheld]" : null,
                dissent: result.dissent ? "[encoded fixture output withheld]" : null,
              }
            : {}),
          // Keep display identities out of command logs.
          citedNames: undefined,
          citedAuthors: undefined,
        }),
      );
      if (controller.signal.aborted) break;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  consensusCheck().catch(() => {
    console.error(
      "Consensus check failed; check the input, configuration and service availability.",
    );
    process.exitCode = 1;
  });
}
