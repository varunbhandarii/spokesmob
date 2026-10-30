import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { generateScenario } from "../../../../tools/crowd-sim/src/generate.js";
import { parseScenario } from "../../../../tools/mock-eventsub/src/scenario.js";
import { createMockLoop } from "../beat/mock-loop.js";
import { loopReport } from "../beat/report.js";
import { loadConfig } from "../config.js";
import { acquireInstanceLock } from "../instance-lock.js";
import { createLogger } from "../log.js";

export function projectLoop(minutes: number, liveModel: boolean, liveVoice: boolean) {
  // A nine-second cadence, one main line plus dissent and one model call per beat.
  const beats = Math.ceil((minutes * 60) / 9);
  return {
    beats,
    expectedModelCalls: liveModel ? beats : 0,
    expectedVoiceCalls: liveVoice ? beats * 2 : 0,
    expectedCostUsd: beats * ((liveModel ? 0.00012 : 0) + (liveVoice ? 2 * 0.000985 : 0)),
    maximumModelAttempts: liveModel ? beats * 2 : 0,
    maximumVoiceAttempts: liveVoice ? beats * 4 : 0,
  };
}
export async function runLoop(
  args = process.argv.slice(2),
  output: (text: string) => void = console.log,
) {
  const { values } = parseArgs({
    args,
    options: {
      mock: { type: "string" },
      authors: { type: "string", default: "300" },
      rate: { type: "string", default: "60" },
      minutes: { type: "string" },
      "live-model": { type: "boolean" },
      "live-voice": { type: "boolean" },
      yes: { type: "boolean" },
      report: { type: "boolean" },
      headless: { type: "boolean" },
      port: { type: "string" },
      "max-cost-usd": { type: "string", default: "0.10" },
    },
  });
  if (!values.mock) throw new Error("Select a mock scenario or crowd");
  const liveModel = !!values["live-model"],
    liveVoice = !!values["live-voice"];
  const minutes = Number(
    values.minutes ?? (values.mock === "crowd" ? "5" : liveModel || liveVoice ? "3" : "0"),
  );
  const budgetLimitUsd = Number(values["max-cost-usd"]);
  const authors = Number(values.authors),
    rate = Number(values.rate);
  if (
    !Number.isFinite(minutes) ||
    minutes < 0 ||
    minutes > 60 ||
    ((liveModel || liveVoice) && minutes <= 0) ||
    !Number.isFinite(budgetLimitUsd) ||
    budgetLimitUsd <= 0 ||
    !Number.isInteger(authors) ||
    authors < 1 ||
    authors > 10000 ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > 1000
  )
    throw new Error("Invalid loop duration, budget or crowd settings");
  if (values.headless && (liveModel || liveVoice))
    throw new Error("Headless mode requires both stubs");
  if (liveModel || liveVoice) {
    const projection = projectLoop(minutes, liveModel, liveVoice);
    output(
      JSON.stringify({ kind: "loop_projection", ...projection, runtimeLimitUsd: budgetLimitUsd }),
    );
    if (!values.yes) {
      output("Paid mode requires explicit approval and --yes. No API call made.");
      return;
    }
    if (projection.expectedCostUsd > budgetLimitUsd)
      throw new Error("Expected loop cost exceeds the selected limit; no API call made");
  }
  const scenario =
    values.mock === "crowd"
      ? generateScenario({ authors, rate, seconds: minutes * 60, seed: 42 })
      : parseScenario(
          await readFile(
            fileURLToPath(
              new URL(
                `../../../../tools/mock-eventsub/scenarios/${values.mock}.jsonl`,
                import.meta.url,
              ),
            ),
            "utf8",
          ),
        );
  const config = loadConfig({
    ...process.env,
    TWITCH_CLIENT_ID: "mock-client",
    TWITCH_CLIENT_SECRET: "synthetic-secret",
    TWITCH_CHANNEL: "spokesmob_demo",
  });
  if (values.port !== undefined) {
    const port = Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid local port");
    config.voice.port = port;
  }
  config.databaseFile = join(dirname(config.tokenFile), "mock-spokesmob.db");
  const log = createLogger(config.logLevel);
  const release = await acquireInstanceLock(config.tokenFile);
  let loop: Awaited<ReturnType<typeof createMockLoop>> | undefined;
  let apiFailure: string | null = null;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = () => finish();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let duration: ReturnType<typeof setTimeout> | undefined;
  let sample: ReturnType<typeof setInterval> | undefined;
  let writes: ReturnType<typeof setInterval> | undefined;
  let started = 0;
  const heap: { atMs: number; bytes: number }[] = [];
  try {
    loop = await createMockLoop({
      config,
      scenario,
      log,
      liveModel,
      liveVoice,
      headless: !!values.headless,
      budgetLimitUsd,
      loop: values.mock !== "crowd",
      apiFailure: (source) => {
        apiFailure = source;
        finish();
      },
    });
    const path = await loop.start();
    output(`Overlay URL saved to ${path}`);
    output(
      "Control URL: copy with npm run voice -- --copy-url control. Twitch traffic stays on the local mock.",
    );
    output(
      liveVoice
        ? "Live voice enabled; waiting for an active audio overlay."
        : "Voice is simulated; no generated PCM is sent. Beat records are marked simulated.",
    );
    if (!liveModel)
      output("Consensus uses an offline stub; quality and model latency are not measured.");
    started = Date.now();
    let callCursor = 0;
    writes = setInterval(() => {
      if (!loop) return;
      for (const call of loop.services.calls.slice(callCursor)) {
        if (
          (call.path === "/helix/chat/messages" && call.method === "POST") ||
          (call.path === "/helix/chat/pins" && ["PUT", "DELETE"].includes(call.method))
        )
          output(
            JSON.stringify({
              kind: "mock_helix",
              method: call.method,
              endpoint: call.path,
              atMs: call.at - started,
            }),
          );
      }
      callCursor = loop.services.calls.length;
    }, 1000);
    const sampleHeap = () =>
      heap.push({ atMs: Date.now() - started, bytes: process.memoryUsage().heapUsed });
    sampleHeap();
    sample = setInterval(sampleHeap, 10000);
    const unhealth = loop.application.runner.onState((view) => {
      if (view.capped) {
        output("Runtime spend limit reached; stopping the mock loop.");
        finish();
      }
    });
    if (minutes > 0) duration = setTimeout(finish, minutes * 60000);
    await finished;
    unhealth();
    await loop.application.runner.stop();
    sampleHeap();
    const rows = [];
    let before: string | undefined;
    for (;;) {
      const batch = loop.application.store.beatLog.recent(1000, before);
      for (const row of batch.filter((row) => row.id.startsWith(`${loop?.application.sessionId}:`)))
        rows.push(loop.application.store.beatLog.reconcileCost(row.id) ?? row);
      if (batch.length < 1000) break;
      before = batch.at(-1)?.id;
    }
    const totals = loop.application.ledger.totals();
    if (values.report || values.mock === "crowd" || apiFailure)
      output(
        JSON.stringify({
          ...loopReport({
            rows,
            calls: loop.services.calls,
            runner: loop.application.runner,
            heap,
            elapsedMs: Date.now() - started,
            apiFailure,
          }),
          costUsd: totals.unknown ? null : totals.spent,
          unknownCostCalls: totals.unknown,
          sessionBudget: totals,
        }),
      );
    if (apiFailure) {
      output("A real API call failed; the mock loop stopped. Usage may be unknown.");
      process.exitCode = 1;
    }
  } finally {
    if (duration) clearTimeout(duration);
    if (sample) clearInterval(sample);
    if (writes) clearInterval(writes);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await loop?.close();
    await release();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runLoop().catch(() => {
    console.error(
      "Mock loop failed; check configuration, scenario, local port and server lock. No credentials were printed.",
    );
    process.exitCode = 1;
  });
