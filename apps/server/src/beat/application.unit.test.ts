import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createMockServer } from "../../../../tools/mock-eventsub/src/server.js";
import { createMockServices } from "../../../../tools/mock-eventsub/src/services.js";
import { loadConfig } from "../config.js";
import { FakeModerationPort } from "../consensus/fakes.js";
import { StubConsensusModel } from "../consensus/stub-model.js";
import { createLogger } from "../log.js";
import { createTwitchRuntime } from "../twitch/runtime.js";
import { createBeatApplication } from "./application.js";

const root = resolve("test-results");
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.restoreAllMocks();
});
test("failed model and voice warm-up leaves the server, control API and Kill available", async () => {
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("External network forbidden"));
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, "beat-start-"));
  cleanup.push(async () => {
    if (!folder.startsWith(`${root}${sep}`)) throw new Error("Unsafe test cleanup");
    await rm(folder, { recursive: true, force: true });
  });
  const services = createMockServices({ online: true });
  const mock = await createMockServer({ services, autoPlay: false });
  cleanup.push(mock.close);
  const config = loadConfig({
    TWITCH_CLIENT_ID: services.clientId,
    TWITCH_CLIENT_SECRET: "synthetic",
    TWITCH_CHANNEL: services.user.login,
    HELIX_URL: mock.helixUrl,
    TWITCH_AUTH_URL: mock.authUrl,
    EVENTSUB_URL: mock.wsUrl,
    TOKEN_FILE: join(folder, "tokens.json"),
  });
  config.voice.port = 0;
  config.databaseFile = ":memory:";
  const log = createLogger("silent");
  const warn = vi.spyOn(log, "warn");
  const twitch = await createTwitchRuntime({
    config,
    log,
    fetch: services.fetch,
    store: {
      load: async () => ({
        accessToken: services.auth.accessToken,
        refreshToken: services.auth.refreshToken,
        clientId: config.clientId,
        userId: services.user.id,
        login: services.user.login,
        scopes: services.auth.scopes,
        obtainedAt: Date.now(),
        expiresAt: Date.now() + 3600000,
      }),
      save: async () => {},
    },
  });
  const model = Object.assign(new StubConsensusModel(), {
    warmup: vi.fn(async () => {
      throw new Error("Synthetic model outage");
    }),
  });
  const factory = vi.fn(() => {
    throw new Error("Synthetic voice outage");
  });
  const app = await createBeatApplication({
    config,
    log,
    twitch,
    model,
    moderation: new FakeModerationPort(),
    factory,
    paidModel: false,
    paidVoice: false,
  });
  cleanup.push(() => app.close());
  const saved = await app.start();
  const url = new URL((await readFile(saved, "utf8")).trim());
  const headers = {
    host: url.host,
    origin: url.origin,
    authorization: `Bearer ${url.searchParams.get("token")}`,
  };
  expect(model.warmup).toHaveBeenCalledOnce();
  expect(factory).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith({ source: "model" }, expect.any(String));
  expect(warn).toHaveBeenCalledWith({ source: "voice" }, expect.any(String));
  expect((await app.voice.http.app.inject({ url: "/healthz", headers })).statusCode).toBe(200);
  expect(
    (await app.voice.http.app.inject({ method: "POST", url: "/api/kill", payload: {}, headers }))
      .statusCode,
  ).toBe(200);
  expect(
    (await app.voice.http.app.inject({ url: "/api/state", headers })).json().state.heldBy,
  ).toContain("killed");
  expect(network).not.toHaveBeenCalled();
});
