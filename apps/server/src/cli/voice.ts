import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { OpenAI } from "openai";
import { WebSocket } from "ws";
import {
  defaultTokenFile,
  loadOpenAIConfig,
  loadVoiceConfig,
  requireOpenAIKey,
} from "../config.js";
import { OpenAIModerationPort } from "../consensus/model.js";
import {
  calibrationMarkdown,
  runVoiceCalibration,
  serializeCalibration,
} from "../voice/calibration.js";
import { CHECK_LINES } from "../voice/check-lines.js";
import { VoiceManager } from "../voice/manager.js";
import { realtimeFactory } from "../voice/transport.js";

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
    let welcomed = false;
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", role: "control" })));
    socket.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString()) as {
          type?: string;
          request?: string;
          data?: unknown;
          role?: string;
        };
        if (response.type === "hello" && response.role === "control" && !welcomed) {
          welcomed = true;
          socket.send(
            JSON.stringify({
              type: "voice_command",
              request,
              mode,
              ...(text ? { text } : {}),
              ...(dissent ? { dissent } : {}),
            }),
          );
        }
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
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
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
      "max-cost-usd": { type: "string", default: "0.10" },
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
  if (
    positionals.length &&
    (!values["copy-url"] || positionals.length !== 1 || positionals[0] !== "control")
  )
    throw new Error("Unsupported voice argument");
  const voice = loadVoiceConfig();
  const tokenFile = process.env.TOKEN_FILE ?? defaultTokenFile();
  if (values["copy-url"]) {
    const url = await overlayUrl(tokenFile);
    if (positionals[0] === "control") url.pathname = "/control/";
    await copyOverlayUrl(url.toString());
    output(`${positionals[0] === "control" ? "Control" : "Overlay"} URL copied to clipboard.`);
    return;
  }
  if (values.tone) {
    output(JSON.stringify(await sendCommand(await overlayUrl(tokenFile), "tone")));
    return;
  }
  const count = values.calibrate === undefined ? 1 : Number(values.calibrate);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000)
    throw new Error("Calibration count must be 1 to 1000");
  const limitUsd = Number(values["max-cost-usd"]);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error("Cost limit must be positive");
  output(
    JSON.stringify({
      kind: "voice_projection",
      lines: count,
      expectedAttempts: count,
      maximumAttempts: count * 2,
      expectedCostUsd: count * 0.0012,
      maximumGenerationEstimateUsd: count * 2 * 0.0085,
      runtimeLimitUsd: limitUsd,
    }),
  );
  if (!values.yes) {
    output("Paid mode requires explicit approval and --yes. No API call made.");
    return;
  }
  if (count * 0.0012 > limitUsd)
    throw new Error("Expected voice cost exceeds the selected limit; no API call made");
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
  const path = values.report
    ? resolve(values.report)
    : join(
        dirname(tokenFile),
        "voice-reports",
        `voice-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );
  if (!path.endsWith(".json")) throw new Error("Voice report must use a JSON path");
  for (const destination of [path, path.replace(/\.json$/, ".md")]) {
    try {
      await access(destination);
      throw new Error("Report already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Voice report destination is unavailable");
    }
  }
  await mkdir(dirname(path), { recursive: true });
  const budget = { limitUsd, reservedUsd: 0 };
  const charged = new Map<string, number>();
  const manager = new VoiceManager({
    mainVoice: voice.mainVoice,
    dissentVoice: voice.dissentVoice,
    factory: realtimeFactory(openai.apiKey ?? "", voice.realtimeUrl),
    transport: { prepare() {}, play() {}, stop() {} },
    allowAttempt: () => {
      if (budget.reservedUsd + 0.0085 > budget.limitUsd) return false;
      budget.reservedUsd += 0.0085;
      return true;
    },
    onUsage: (take, attempt, _usage, cost) => {
      const key = `${take}:${attempt}`;
      const previous = charged.get(key) ?? 0.0085;
      const current = cost ?? previous;
      budget.reservedUsd += current - previous;
      charged.set(key, current);
    },
  });
  const report = await runVoiceCalibration({
    count,
    lines: lines as string[],
    manager,
    moderation,
    budget,
    output,
  });
  await writeFile(path, `${serializeCalibration(report)}\n`, { flag: "wx" });
  await writeFile(path.replace(/\.json$/, ".md"), calibrationMarkdown(report), { flag: "wx" });
  output(JSON.stringify({ kind: "voice_summary", ...report.summary, report: path }));
  if (report.summary.aborted) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  voiceCheck().catch(() => {
    console.error(
      "Voice check failed; check local server, audio client, input and service availability.",
    );
    process.exitCode = 1;
  });
