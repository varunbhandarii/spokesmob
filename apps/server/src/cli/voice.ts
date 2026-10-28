import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { OpenAI } from "openai";
import { WebSocket } from "ws";
import { createBlocklist } from "../../../../packages/core/src/blocklist.js";
import { verifyTemplated } from "../../../../packages/core/src/verify.js";
import {
  defaultTokenFile,
  loadOpenAIConfig,
  loadVoiceConfig,
  requireOpenAIKey,
} from "../config.js";
import { OpenAIModerationPort } from "../consensus/model.js";
import { CHECK_LINES } from "../voice/check-lines.js";
import { VoiceManager } from "../voice/manager.js";
import { realtimeFactory } from "../voice/transport.js";
import type { VoiceResult } from "../voice/types.js";

const percentile = (values: number[], fraction: number) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? null;
};
async function overlayUrl(tokenFile: string) {
  const value = (await readFile(join(dirname(tokenFile), "overlay-url.txt"), "utf8")).trim();
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.searchParams.get("token"))
    throw new Error("Invalid local overlay URL");
  return url;
}
async function copyOverlayUrl(url: string): Promise<void> {
  if (process.platform !== "win32")
    throw new Error("Clipboard copy is currently available on Windows");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$value = [Console]::In.ReadToEnd(); Set-Clipboard -Value $value",
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    child.on("error", () => reject(new Error("Clipboard unavailable")));
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("Clipboard unavailable")),
    );
    child.stdin.end(url);
  });
}
async function sendCommand(
  url: URL,
  mode: "tone" | "say" | "kill_test",
  text?: string,
  dissent?: boolean,
) {
  const endpoint = new URL("/ws", url);
  endpoint.protocol = "ws:";
  endpoint.searchParams.set("token", url.searchParams.get("token") ?? "");
  const request = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(endpoint, { origin: url.origin });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Voice check deadline"));
    }, 90000);
    const finish = () => {
      clearTimeout(timer);
      socket.close();
    };
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          type: "voice_command",
          request,
          mode,
          ...(text ? { text } : {}),
          ...(dissent ? { dissent } : {}),
        }),
      ),
    );
    socket.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString()) as {
          type?: string;
          request?: string;
          data?: unknown;
        };
        if (response.type === "voice_result" && response.request === request) {
          finish();
          resolve(response.data);
        }
      } catch {
        /* Ignore unsupported local messages. */
      }
    });
    socket.on("error", () => {
      finish();
      reject(new Error("Local voice server unavailable"));
    });
  });
}
export async function voiceCheck(
  args = process.argv.slice(2),
  output: (line: string) => void = console.log,
) {
  const { values } = parseArgs({
    args,
    options: {
      tone: { type: "boolean" },
      say: { type: "string" },
      dissent: { type: "boolean" },
      calibrate: { type: "string" },
      lines: { type: "string" },
      report: { type: "string" },
      "kill-test": { type: "boolean" },
      "copy-url": { type: "boolean" },
      yes: { type: "boolean" },
    },
  });
  const modes = [
    values.tone,
    values.say !== undefined,
    values.calibrate !== undefined,
    values["kill-test"],
    values["copy-url"],
  ].filter(Boolean).length;
  if (modes !== 1) throw new Error("Select one voice check mode");
  const voice = loadVoiceConfig();
  const tokenFile = process.env.TOKEN_FILE ?? defaultTokenFile();
  if (values["copy-url"]) {
    await copyOverlayUrl((await overlayUrl(tokenFile)).toString());
    output("Overlay URL copied to clipboard.");
    return;
  }
  if (values.tone) {
    output(JSON.stringify(await sendCommand(await overlayUrl(tokenFile), "tone")));
    return;
  }
  const count = values.calibrate === undefined ? 1 : Number(values.calibrate);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
    throw new Error("Calibration count must be 1 to 1000");
  output(
    JSON.stringify({
      kind: "voice_projection",
      lines: count,
      expectedAttempts: count,
      maximumAttempts: count * 2,
      expectedCostUsd: count * 0.0012,
      maximumGenerationEstimateUsd: count * 2 * 0.0085,
    }),
  );
  if (!values.yes) {
    output("Paid mode requires explicit approval and --yes. No API call made.");
    return;
  }
  if (!values.calibrate) {
    output(
      JSON.stringify(
        await sendCommand(
          await overlayUrl(tokenFile),
          values["kill-test"] ? "kill_test" : "say",
          values.say,
          values.dissent,
        ),
      ),
    );
    return;
  }
  const openai = loadOpenAIConfig();
  const lines: unknown = values.lines
    ? JSON.parse(await readFile(resolve(values.lines), "utf8"))
    : CHECK_LINES;
  if (
    !Array.isArray(lines) ||
    !lines.length ||
    lines.some((line) => typeof line !== "string" || !line.trim())
  )
    throw new Error("Line file must contain a JSON string array");
  const client = new OpenAI({ apiKey: requireOpenAIKey(openai), maxRetries: 0 });
  const moderation = new OpenAIModerationPort(client);
  const blocklist = createBlocklist();
  const manager = new VoiceManager({
    mainVoice: voice.mainVoice,
    dissentVoice: voice.dissentVoice,
    factory: realtimeFactory(openai.apiKey ?? "", voice.realtimeUrl),
    transport: { prepare() {}, play() {}, stop() {} },
  });
  const samples: {
    index: number;
    text: string;
    readyMs: number;
    result: VoiceResult;
    playbackStartMs: null;
    releaseEligibleMs: number;
  }[] = [];
  try {
    await manager.start();
    for (let index = 0; index < count; index++) {
      const line = String(lines[index % lines.length]);
      if (blocklist.check(line).blocked) throw new Error("Calibration line rejected by blocklist");
      const moderationResult = await moderation.moderate([line]);
      const item = moderationResult.results[0];
      const gate = verifyTemplated(line, {
        blocklist,
        moderation:
          moderationResult.results.length === 1 && item
            ? {
                status: "ok",
                flagged: item.flagged || Object.values(item.categories).some(Boolean),
              }
            : { status: "error" },
      });
      if (!gate.ok) throw new Error("Calibration line failed output verification");
      const start = Date.now();
      const take = manager.prepare(line, index % 2 ? "dissent" : "main");
      const result = await take.ready;
      const readyMs = Date.now() - start;
      samples.push({
        index: index + 1,
        text: line,
        readyMs,
        result: { ...result },
        playbackStartMs: null,
        releaseEligibleMs: Math.max(1000, readyMs),
      });
      output(
        JSON.stringify({
          kind: "voice_sample",
          index: index + 1,
          status: result.status,
          readyMs,
          attempts: result.attempts.length,
        }),
      );
      take.cancel("calibration_complete");
    }
  } finally {
    manager.close();
  }
  const attempts = samples.flatMap((sample) => sample.result.attempts);
  const cost = attempts.some((attempt) => attempt.costUsd === null)
    ? null
    : attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0);
  const latencies = (key: "ttfaMs" | "completeMs") =>
    attempts.flatMap((attempt) => (attempt[key] === null ? [] : [attempt[key] as number]));
  const stats = (numbers: number[]) => ({
    p50: percentile(numbers, 0.5),
    p95: percentile(numbers, 0.95),
    max: numbers.length ? Math.max(...numbers) : null,
  });
  const summary = {
    lines: count,
    verified: samples.filter((sample) => sample.result.status === "verified").length,
    firstAudioMs: stats(latencies("ttfaMs")),
    completeMs: stats(latencies("completeMs")),
    readyMs: stats(samples.map((sample) => sample.readyMs)),
    releaseEligibleMs: stats(samples.map((sample) => sample.releaseEligibleMs)),
    playbackMeasured: false,
    meanSimilarity:
      attempts
        .filter((attempt) => attempt.similarity !== null)
        .reduce((sum, attempt) => sum + (attempt.similarity ?? 0), 0) /
      Math.max(1, attempts.filter((attempt) => attempt.similarity !== null).length),
    refusals: attempts.filter((attempt) => attempt.reason === "refusal").length,
    drifts: attempts.filter((attempt) => attempt.reason === "drift").length,
    totalCostUsd: cost,
    meanCostPerLineUsd: cost === null ? null : cost / count,
    budget: {
      consensusP95Ms: 1217,
      assemblyMs: 50,
      verifierMs: 10,
      preRollMs: 100,
      previewHoldMs: 1000,
      estimatedCloseToVerifiedAudioP95Ms:
        50 +
        1217 +
        10 +
        Math.max(
          1000,
          percentile(
            samples.map((sample) => sample.readyMs),
            0.95,
          ) ?? 0,
        ) +
        100,
      inputModerationNotIncluded: true,
    },
  };
  const path = values.report
    ? resolve(values.report)
    : join(
        dirname(tokenFile),
        "voice-reports",
        `voice-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
  if (!path.endsWith(".json")) throw new Error("Voice report must use a JSON path");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ summary, samples }, null, 2)}\n`, { flag: "wx" });
  await writeFile(
    path.replace(/\.json$/, ".md"),
    `# Voice calibration\n\n${JSON.stringify(summary, null, 2)}\n\nPlayback start is unmeasured without an overlay. Release-eligible time includes the 1 s stand-in preview. No PCM was saved.\n`,
    { flag: "wx" },
  );
  output(JSON.stringify({ kind: "voice_summary", ...summary, report: path }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  voiceCheck().catch(() => {
    console.error(
      "Voice check failed; check local server, audio client, input and service availability.",
    );
    process.exitCode = 1;
  });
