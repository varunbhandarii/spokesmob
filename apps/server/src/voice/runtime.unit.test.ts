import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createLogger } from "../log.js";
import { createVoiceRuntime } from "./runtime.js";

const root = resolve("test-results");
const folders: string[] = [];
afterEach(async () => {
  for (const path of folders.splice(0)) {
    if (!path.startsWith(`${root}${sep}`)) throw new Error("Unsafe test cleanup");
    await rm(path, { recursive: true, force: true });
  }
});
test("the free tone follows the verified take/socket path without opening an API session", async () => {
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, "voice-runtime-"));
  folders.push(folder);
  let modelConnections = 0;
  const runtime = await createVoiceRuntime({
    tokenFile: join(folder, "tokens.json"),
    voice: {
      provider: "realtime",
      mainVoice: "cedar",
      dissentVoice: "sage",
      port: 0,
      spendCapUsd: 5,
    },
    openai: { serviceTier: "fast", minVoices: 2 },
    log: createLogger("silent"),
    factory: () => {
      modelConnections++;
      throw new Error("No API session allowed for a tone");
    },
  });
  const sockets: WebSocket[] = [];
  try {
    const path = await runtime.start();
    const { readFile } = await import("node:fs/promises");
    const url = new URL((await readFile(path, "utf8")).trim());
    const endpoint = new URL("/ws", url);
    endpoint.protocol = "ws:";
    endpoint.search = url.search;
    const overlay = new WebSocket(endpoint, { origin: url.origin });
    sockets.push(overlay);
    let pcmBytes = 0;
    overlay.on("message", (raw, binary) => {
      if (binary) {
        pcmBytes += (raw as Buffer).length - 9;
        return;
      }
      const message = JSON.parse(raw.toString()) as { type: string; take: number };
      if (message.type === "play") {
        overlay.send(JSON.stringify({ type: "started", take: message.take }));
        overlay.send(JSON.stringify({ type: "played", take: message.take, samples: pcmBytes / 2 }));
        overlay.send(JSON.stringify({ type: "ended", take: message.take }));
      }
    });
    await once(overlay, "open");
    const hello = once(overlay, "message");
    overlay.send(JSON.stringify({ type: "hello", role: "overlay", audio: true, obs: true }));
    await hello;
    const control = new WebSocket(endpoint, { origin: url.origin });
    sockets.push(control);
    await once(control, "open");
    const welcome = once(control, "message");
    control.send(JSON.stringify({ type: "hello", role: "control" }));
    await welcome;
    const response = once(control, "message");
    control.send(JSON.stringify({ type: "voice_command", request: "test-tone", mode: "tone" }));
    const [raw] = await response;
    const result = JSON.parse(String(raw)) as {
      data: { status: string; playback: string; trim: { totalMs: number } };
    };
    expect(result.data.status).toBe("verified");
    expect(result.data.playback).toBe("ended");
    expect(result.data.trim.totalMs).toBe(0);
    expect(pcmBytes).toBe(48000);
    expect(modelConnections).toBe(0);
  } finally {
    for (const socket of sockets) socket.terminate();
    await runtime.close();
  }
});
