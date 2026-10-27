import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { OpenAI } from "openai";
import { loadOpenAIConfig, requireOpenAIKey } from "../../apps/server/src/config.js";
import {
  OpenAIConsensusModel,
  OpenAIModerationPort,
} from "../../apps/server/src/consensus/model.js";
import { evaluate } from "./evaluate.js";
import { loadGoldens } from "./golden.js";
import { evaluationPlan } from "./plan.js";
import { writeReport } from "./report.js";

export async function runEvaluation(
  options: { args?: string[]; output?: (line: string) => void } = {},
) {
  const { values } = parseArgs({
    args: options.args ?? process.argv.slice(2),
    options: {
      tags: { type: "string" },
      n: { type: "string", default: "5" },
      tier: { type: "string" },
      offline: { type: "boolean" },
      report: { type: "string" },
      plan: { type: "boolean" },
      persona: { type: "string", default: "deadpan" },
    },
  });
  const n = Number(values.n);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("Sample count must be a positive integer");
  if (values.persona !== "deadpan") throw new Error("Only the deadpan persona is supported");
  const config = loadOpenAIConfig();
  const tier = values.tier ?? config.serviceTier;
  if (tier !== "default" && tier !== "fast") throw new Error("Tier must be default or fast");
  const tags = values.tags?.split(",").filter(Boolean) ?? [];
  const windows = (await loadGoldens()).filter(
    (window) => !tags.length || window.tags.some((tag) => tags.includes(tag)),
  );
  if (!windows.length) throw new Error("No golden windows match the selected tags");
  const output = options.output ?? console.log;
  const plan = evaluationPlan(windows, n, tier, config.minVoices);
  output(JSON.stringify({ kind: "plan", offline: !!values.offline, ...plan }));
  if (values.plan) return null;
  if (values.offline)
    output(
      "OFFLINE: unmoderated stub evaluation; not evidence of streaming safety or model quality. No API calls.",
    );
  const client = values.offline
    ? null
    : new OpenAI({ apiKey: requireOpenAIKey(config), maxRetries: 0 });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const report = await evaluate({
      windows,
      n,
      offline: !!values.offline,
      serviceTier: tier,
      minVoices: config.minVoices,
      signal: controller.signal,
      ...(client
        ? {
            ports: () => ({
              model: new OpenAIConsensusModel({ client, serviceTier: tier }),
              moderation: new OpenAIModerationPort(client),
            }),
          }
        : {}),
    });
    const paths = await writeReport(report, values.report);
    for (const [category, row] of Object.entries(report.summary.categories)) {
      output(
        `${category}: ${row.passed}/${row.samples} hard passes; ${(row.speakingRate * 100).toFixed(1)}% speaking`,
      );
    }
    output(
      JSON.stringify({
        kind: "summary",
        ...report.summary,
        aborted: report.aborted,
        reports: paths,
      }),
    );
    return report;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runEvaluation()
    .then((report) => {
      if (
        report?.aborted ||
        (report &&
          !report.offline &&
          Object.values(report.summary.gates).some((value) => value === false))
      )
        process.exitCode = 1;
    })
    .catch(() => {
      console.error(
        "Evaluation stopped; check arguments, projected cost, input files and service availability.",
      );
      process.exitCode = 1;
    });
}
