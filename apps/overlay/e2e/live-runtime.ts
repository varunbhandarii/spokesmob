import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  type ControlMessage,
  serverControlMessageSchema,
} from "../../../packages/core/src/overlay-protocol.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10000) {
  const end = performance.now() + timeoutMs;
  while (!(await check())) {
    if (performance.now() >= end) throw new Error("Local smoke deadline exceeded");
    await delay(25);
  }
}
async function stopChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await until(() => child.exitCode !== null || child.signalCode !== null, 3000);
  } catch {
    child.kill("SIGKILL");
    await until(() => child.exitCode !== null || child.signalCode !== null, 3000);
  }
}
export async function startMockLoop(demo = false) {
  const folder = await mkdtemp(join(tmpdir(), "spokesmob-browser-"));
  const target = resolve(folder);
  const expectedParent = resolve(tmpdir());
  const environment: NodeJS.ProcessEnv = {};
  const osKeys = new Set([
    "PATH",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "COMSPEC",
    "PATHEXT",
  ]);
  for (const [key, value] of Object.entries(process.env))
    if (osKeys.has(key.toUpperCase())) environment[key] = value;
  Object.assign(environment, {
    TOKEN_FILE: join(folder, "tokens.json"),
    BEAT_MODE: "demand",
    LOG_LEVEL: "silent",
  });
  // No env-file loader, inherited credentials or paid flags enter this child.
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "apps/server/src/cli/loop.ts",
      "--mock",
      "crowd",
      "--authors",
      "400",
      "--rate",
      "200",
      "--minutes",
      "1",
      ...(demo ? [] : ["--headless"]),
      "--port",
      "0",
    ],
    { cwd: repo, env: environment, stdio: "ignore", windowsHide: true },
  );
  let spawnFailed = false;
  child.on("error", () => {
    spawnFailed = true;
  });
  const close = async () => {
    await stopChild(child);
    // Recursive cleanup is restricted to the exact generated temporary child.
    if (dirname(target) !== expectedParent || !basename(target).startsWith("spokesmob-browser-"))
      throw new Error("Temporary-folder cleanup refused");
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    const remains = await access(target).then(
      () => true,
      () => false,
    );
    if (remains) throw new Error("Temporary-folder cleanup incomplete");
  };
  try {
    let saved = "";
    await until(async () => {
      if (spawnFailed || child.exitCode !== null)
        throw new Error("Local mock loop failed to start");
      saved = await readFile(join(folder, "overlay-url.txt"), "utf8").catch(() => "");
      return saved.trim().length > 0;
    }, 15000);
    const url = new URL(saved.trim());
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("token") ?? "")
    )
      throw new Error("Saved local overlay address is invalid");
    return { url, close };
  } catch {
    await close();
    throw new Error("Isolated mock loop unavailable");
  }
}
export async function controlClient(url: URL) {
  const endpoint = new URL("/ws", url.origin);
  endpoint.protocol = "ws:";
  endpoint.search = url.search;
  const socket = new WebSocket(endpoint, { origin: url.origin });
  let failed = false;
  const messages: ControlMessage[] = [];
  socket.on("error", () => {
    failed = true;
  });
  socket.on("message", (data, binary) => {
    if (binary) {
      failed = true;
      return;
    }
    try {
      const result = serverControlMessageSchema.safeParse(JSON.parse(data.toString()));
      if (result.success) messages.push(result.data);
      else failed = true;
    } catch {
      failed = true;
    }
  });
  try {
    await until(() => {
      if (failed) throw new Error("Local control connection failed");
      return socket.readyState === WebSocket.OPEN;
    });
    socket.send(JSON.stringify({ type: "hello", role: "control" }));
    await until(() => messages.some((message) => message.type === "hello"));
    return {
      messages,
      command(command: unknown) {
        socket.send(JSON.stringify({ type: "command", request: "browser-command", command }));
      },
      tone() {
        socket.send(
          JSON.stringify({ type: "voice_command", request: "browser-tone", mode: "tone" }),
        );
      },
      close: () => socket.terminate(),
    };
  } catch {
    socket.terminate();
    throw new Error("Local control connection unavailable");
  }
}
