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
import { loadQualityBaseline } from "./regression.js";
import { writeReport } from "./report.js";

export async function runEvaluation(
  options: { args?: string[]; output?: (line: string) => void } = {},
) {
  const { values } = parseArgs({
    args: options.args ?? process.argv.slice(2),
    options: {
      tags: { type: "string" },
      window: { type: "string" },
      n: { type: "string", default: "5" },
      tier: { type: "string" },
      "compare-tiers": { type: "boolean" },
      "max-cost-usd": { type: "string", default: "0.50" },
      baseline: { type: "string" },
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
  if (values["compare-tiers"] && values.tier)
    throw new Error("Select either a tier or the comparison");
  const tier = values["compare-tiers"] ? "interleaved" : (values.tier ?? config.serviceTier);
  if (tier !== "default" && tier !== "fast" && tier !== "interleaved")
    throw new Error("Tier must be default or fast");
  const maxCostUsd = Number(values["max-cost-usd"]);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 0.5)
    throw new Error("Cost limit must be positive and at most $0.50");
  const tags = values.tags?.split(",").filter(Boolean) ?? [];
  const windows = (await loadGoldens()).filter(
    (window) =>
      (!values.window || window.id === values.window) &&
      (!tags.length || window.tags.some((tag) => tags.includes(tag))),
  );
  if (!windows.length) throw new Error("No golden windows match the selection");
  const output = options.output ?? console.log;
  const plan = evaluationPlan(windows, n, tier, config.minVoices);
  output(JSON.stringify({ kind: "plan", offline: !!values.offline, maxCostUsd, ...plan }));
  if (values.plan) return null;
  const baseline = values.baseline ? await loadQualityBaseline(values.baseline) : undefined;
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
      maxCostUsd,
      ...(baseline ? { baseline } : {}),
      minVoices: config.minVoices,
      signal: controller.signal,
      ...(client
        ? {
            ports: (requestedTier: "default" | "fast") => ({
              model: new OpenAIConsensusModel({ client, serviceTier: requestedTier }),
              moderation: new OpenAIModerationPort(client),
            }),
          }
        : {}),
    });
    const paths = await writeReport(report, values.report);
    for (const [requestedTier, summary] of Object.entries(report.tierSummaries)) {
      for (const [category, row] of Object.entries(summary.categories)) {
        output(
          `${requestedTier} ${category}: ${row.qualityPassed}/${row.samples} quality; ${row.withLatencyPassed}/${row.samples} with latency; A12 ${row.a12Samples ? `${row.a12Passed}/${row.a12Samples}` : "not measured"}`,
        );
      }
    }
    output(
      JSON.stringify({
        kind: "summary",
        ...report.summary,
        tiers: report.tierSummaries,
        qualityRegression: report.qualityRegression,
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
