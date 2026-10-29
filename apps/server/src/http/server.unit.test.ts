import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { loadOverlayToken, saveOverlayUrl, tokenMatches } from "./overlay-token.js";
import { createHttpServer } from "./server.js";
import { encodeAudioFrame } from "./ws-hub.js";

const root = resolve("test-results");
const folders: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  for (const path of folders.splice(0)) {
    if (!path.startsWith(`${root}${sep}`)) throw new Error("Unsafe test cleanup");
    await rm(path, { recursive: true, force: true });
  }
});
async function folder() {
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, "local-overlay-"));
  folders.push(path);
  return path;
}
async function server() {
  const path = await folder();
  await writeFile(join(path, "index.html"), "<p>synthetic overlay</p>");
  const http = await createHttpServer({ token: "synthetic-token", port: 0, overlayRoot: path });
  const origin = await http.listen();
  const url = origin.replace("http", "ws");
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await http.close();
  });
  async function connect(audio: boolean) {
    const socket = new WebSocket(`${url}/ws?token=synthetic-token`, { origin });
    sockets.push(socket);
    const frames: { binary: boolean; data: Buffer }[] = [];
    socket.on("message", (data, binary) =>
      frames.push({ binary, data: Buffer.from(data as Buffer) }),
    );
    await once(socket, "open");
    const hello = once(socket, "message");
    socket.send(JSON.stringify({ type: "hello", role: "overlay", audio, obs: audio }));
    await hello;
    return { socket, frames };
  }
  return { ...http, origin, url, connect };
}
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("Local socket did not settle");
}
test("overlay credentials are stable and the full URL is saved without output", async () => {
  const path = await folder();
  const tokenFile = join(path, "tokens.json");
  const first = await loadOverlayToken(tokenFile);
  const second = await loadOverlayToken(tokenFile);
  expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).toEqual(first);
  const url = await saveOverlayUrl(tokenFile, 4040, first.token);
  expect((await readFile(url.path, "utf8")).trim()).toBe(url.url);
  expect(tokenMatches(first.token, first.token)).toBe(true);
  expect(tokenMatches(first.token, "wrong")).toBe(false);
});
test("local static serving rejects bad Host and WebSocket token or Origin", async () => {
  const f = await server();
  expect((await fetch(`${f.origin}/overlay/`)).status).toBe(200);
  expect(
    (await f.app.inject({ url: "/healthz", headers: { host: "attacker.invalid" } })).statusCode,
  ).toBe(403);
  for (const [token, origin] of [
    ["wrong", f.origin],
    ["synthetic-token", "https://attacker.invalid"],
  ]) {
    const socket = new WebSocket(`${f.url}/ws?token=${token}`, { origin });
    const status = await new Promise<number>((resolve) => {
      socket.on("error", () => undefined);
      socket.on("unexpected-response", (_request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
        socket.terminate();
      });
    });
    expect(status).toBe(403);
  }
});
test("binary frames use network-order take/chunk headers and preserve PCM", () => {
  const frame = encodeAudioFrame("dissent", 0x12345678, 3, Uint8Array.from([0, 128, 255, 127]));
  expect([...frame.subarray(0, 9)]).toEqual([1, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 3]);
  expect([...frame.subarray(9)]).toEqual([0, 128, 255, 127]);
});
test("newest audio client wins, silent previews receive no PCM and hello resync never resurrects playback", async () => {
  const f = await server();
  const first = await f.connect(true);
  const preview = await f.connect(false);
  const second = await f.connect(true);
  await until(() => first.frames.some((frame) => frame.data.toString().includes('"audio":false')));
  const reports: unknown[] = [];
  f.hub.onReport((event) => reports.push(event));
  f.hub.prepare(1, "main", "A synthetic line");
  f.hub.play(1, "main", new Uint8Array(48000), 1000);
  await until(() => second.frames.filter((frame) => frame.binary).length === 2);
  expect(first.frames.filter((frame) => frame.binary)).toHaveLength(0);
  expect(preview.frames.filter((frame) => frame.binary)).toHaveLength(0);
  second.socket.send(JSON.stringify({ type: "ended", take: 1 }));
  await until(() => reports.length === 1);
  first.socket.send(JSON.stringify({ type: "ended", take: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(reports).toHaveLength(1);
  const before = second.frames.filter((frame) => frame.binary).length;
  second.socket.send(JSON.stringify({ type: "hello", role: "overlay", audio: true, obs: true }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(second.frames.filter((frame) => frame.binary)).toHaveLength(before);
});

test("shutdown closes a connected overlay instead of waiting for its browser tab", async () => {
  const f = await server();
  const client = await f.connect(true);
  const closed = once(client.socket, "close");
  await f.close();
  await closed;
  expect(client.socket.readyState).toBe(WebSocket.CLOSED);
});

test("socket roles enforce commands, private feeds, audio ownership and playback reports", async () => {
  const f = await server();
  const overlay = await f.connect(true);
  const silent = await f.connect(false);
  const control = new WebSocket(`${f.url}/ws?token=synthetic-token`, { origin: f.origin });
  const frames: { binary: boolean; data: Buffer }[] = [];
  control.on("message", (data, binary) =>
    frames.push({ binary, data: Buffer.from(data as Buffer) }),
  );
  await once(control, "open");
  const actions: unknown[] = [];
  const checks: unknown[] = [];
  const reports: unknown[] = [];
  f.hub.onAction(async (action) => {
    actions.push(action);
    return { ok: true, reason: null };
  });
  f.hub.onCommand((command) => checks.push(command));
  f.hub.onReport((report) => reports.push(report));
  const command = { type: "command", request: "test-veto", command: { action: "veto" } };
  const voice = { type: "voice_command", request: "test-tone", mode: "tone" };
  control.send(JSON.stringify(command));
  control.send(JSON.stringify(voice));
  const hello = once(control, "message");
  control.send(JSON.stringify({ type: "hello", role: "control" }));
  const [welcome] = await hello;
  expect(JSON.parse(String(welcome))).toMatchObject({
    role: "control",
    audio: false,
    state: { step: "off" },
  });
  expect(actions).toEqual([]);
  expect(checks).toEqual([]);
  overlay.socket.send(JSON.stringify(command));
  silent.socket.send(JSON.stringify(voice));
  // An established overlay cannot turn itself into a control socket.
  overlay.socket.send(JSON.stringify({ type: "hello", role: "control" }));
  overlay.socket.send(JSON.stringify(command));
  control.send(JSON.stringify({ type: "hello", role: "overlay", audio: true, obs: true }));
  control.send(JSON.stringify({ type: "active", active: false }));
  control.send(JSON.stringify({ type: "ended", take: 5 }));
  control.send(JSON.stringify(command));
  control.send(JSON.stringify(voice));
  f.hub.prepare(5, "main", "A verified synthetic line");
  f.hub.play(5, "main", new Uint8Array(48000), 1000);
  f.hub.emitControl({ type: "cost", usdSession: 0, usdHour: 0, cap: 5 });
  await until(
    () =>
      actions.length === 1 &&
      checks.length === 1 &&
      frames.some((frame) => frame.data.toString().includes('"type":"cost"')) &&
      overlay.frames.some((frame) => frame.binary),
  );
  expect(f.hub.hasAudioClient).toBe(true);
  expect(actions).toEqual([{ action: "veto" }]);
  expect(reports).toEqual([]);
  expect(
    frames.some(
      (frame) => frame.binary || /"type":"(?:prepare|play|stop)"/u.test(frame.data.toString()),
    ),
  ).toBe(false);
  expect(overlay.frames.some((frame) => frame.data.toString().includes('"type":"cost"'))).toBe(
    false,
  );
  f.hub.stop("all");
  overlay.socket.send(JSON.stringify({ type: "active", active: false }));
  await until(() => !f.hub.hasAudioClient);
  expect(f.hub.audioConnected).toBe(true);
  expect(f.hub.hasOverlayClient).toBe(true);
});
