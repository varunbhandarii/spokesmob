import { mkdtemp, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createMockServices } from "../../../../tools/mock-eventsub/src/services.js";
import { systemClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { TokenProvider } from "./auth.js";
import { deviceFlow } from "./device-flow.js";
import { TWITCH_SCOPES } from "./scopes.js";
import { createTokenStore, type StoredToken, type TokenStore } from "./token-store.js";

const config = loadConfig({
  TWITCH_CLIENT_ID: "mock-client",
  TWITCH_CLIENT_SECRET: "mock-secret",
  TWITCH_CHANNEL: "spokesmob_demo",
  TWITCH_AUTH_URL: "http://mock/oauth2",
});
const log = createLogger("silent");
const providers: TokenProvider[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
});
afterEach(() => {
  for (const provider of providers.splice(0)) provider.stop();
  vi.useRealTimers();
});

function fixture() {
  const mock = createMockServices({ clock: systemClock });
  let saved: StoredToken = {
    accessToken: mock.auth.accessToken,
    refreshToken: mock.auth.refreshToken,
    expiresAt: Date.now() + 3_600_000,
    obtainedAt: Date.now(),
    userId: mock.auth.userId,
    login: mock.auth.login,
    scopes: [...TWITCH_SCOPES],
    clientId: config.clientId,
  };
  const store: TokenStore = {
    load: async () => saved,
    save: async (token) => {
      saved = token;
    },
  };
  const states: string[] = [];
  const provider = new TokenProvider({
    config,
    store,
    fetch: mock.fetch,
    log,
    clock: systemClock,
    onState: (state) => states.push(state),
  });
  providers.push(provider);
  return { mock, provider, store, states, saved: () => saved };
}

test("device authorization polls pending and slowdown without exposing its machine credential", async () => {
  const mock = createMockServices({ clock: systemClock });
  mock.auth.pollResponses = ["authorization_pending", "slow_down"];
  const show = vi.fn();
  const result = deviceFlow(config, show, { fetch: mock.fetch, clock: systemClock });
  await vi.advanceTimersByTimeAsync(20_000);
  const token = await result;
  expect(token.scopes).toEqual(TWITCH_SCOPES);
  expect(show).toHaveBeenCalledOnce();
  expect(Object.keys(show.mock.calls[0]?.[0] as object).sort()).toEqual([
    "expiresAt",
    "userCode",
    "verificationUrl",
  ]);
  expect(
    mock.calls
      .filter((call) => call.path.endsWith("/token"))
      .map((call) => call.at - Date.now() + 20_000),
  ).toEqual([5000, 10000, 20000]);
  expect(JSON.stringify(mock.calls)).not.toContain("mock-device-code");
});

test("expired activation and missing scopes fail closed", async () => {
  const mock = createMockServices({ clock: systemClock });
  mock.auth.deviceExpiresIn = 5;
  const expired = expect(
    deviceFlow(config, () => undefined, { fetch: mock.fetch, clock: systemClock }),
  ).rejects.toThrow("expired");
  await vi.advanceTimersByTimeAsync(5000);
  await expired;
  mock.auth.deviceExpiresIn = 1800;
  mock.auth.scopes = ["user:read:chat"];
  const missing = expect(
    deviceFlow(config, () => undefined, { fetch: mock.fetch, clock: systemClock }),
  ).rejects.toThrow("user:write:chat");
  await vi.advanceTimersByTimeAsync(5000);
  await missing;
});

test("concurrent unauthorized requests share one refresh and persist before use", async () => {
  const f = fixture();
  await f.provider.start();
  const previous = await f.provider.getAccessToken();
  let release: (() => void) | undefined;
  f.store.save = async (token) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(token.refreshToken).toBe(f.mock.auth.refreshToken);
  };
  let returned = false;
  const responses = Promise.all([
    f.provider.onUnauthorized(previous),
    f.provider.onUnauthorized(previous),
    f.provider.onUnauthorized(previous),
  ]).then((tokens) => {
    returned = true;
    return tokens;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(returned).toBe(false);
  expect(release).toBeTypeOf("function");
  release?.();
  const tokens = await responses;
  expect(new Set(tokens).size).toBe(1);
  expect(tokens[0]).not.toBe(previous);
  expect(f.mock.calls.filter((call) => call.body.grant_type === "refresh_token")).toHaveLength(1);
  expect(
    f.mock.calls.find((call) => call.body.grant_type === "refresh_token")?.clientSecretPresent,
  ).toBe(true);
  await f.provider.onUnauthorized(previous);
  expect(f.mock.calls.filter((call) => call.body.grant_type === "refresh_token")).toHaveLength(1);
});

test("startup validation refreshes a rejected token and validates every 55 minutes", async () => {
  const f = fixture();
  f.mock.auth.validation401Count = 1;
  await f.provider.start();
  expect(f.mock.calls.filter((call) => call.path.endsWith("/validate"))).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(55 * 60_000);
  expect(f.mock.calls.filter((call) => call.path.endsWith("/validate"))).toHaveLength(3);
});

test("near expiry refreshes and persists whichever refresh token is returned", async () => {
  const f = fixture();
  f.mock.auth.expiresIn = 60;
  f.mock.auth.rotateRefresh = true;
  await f.provider.start();
  await f.provider.getAccessToken();
  expect(f.saved().refreshToken).toBe(f.mock.auth.refreshToken);
  expect(f.mock.calls.filter((call) => call.body.grant_type === "refresh_token")).toHaveLength(1);
});

test("invalid refresh, changed identity and missing scopes require sign-in", async () => {
  for (const reason of ["refresh", "identity", "scope"] as const) {
    const f = fixture();
    await f.provider.start();
    if (reason === "refresh") {
      f.mock.auth.invalidRefresh = true;
      await expect(f.provider.onUnauthorized()).rejects.toThrow("refresh failed");
    }
    if (reason === "identity") {
      f.mock.auth.userId = "another-user";
      await expect(f.provider.validate()).rejects.toThrow("user changed");
    }
    if (reason === "scope") {
      f.mock.auth.scopes = [];
      await expect(f.provider.validate()).rejects.toThrow("Missing Twitch scopes");
    }
    await expect(f.provider.getAccessToken()).rejects.toThrow("sign-in required");
    expect(f.states.at(-1)).toBe("auth_required");
  }
});

test("token storage replaces atomically and ignores a different application", async () => {
  const directory = await mkdtemp(join(process.cwd(), "token-test-"));
  const file = join(directory, "tokens.json");
  try {
    const f = fixture();
    const store = createTokenStore(file, config.clientId);
    await store.save(f.saved());
    await store.save({ ...f.saved(), login: "updated_user" });
    expect((await store.load())?.login).toBe("updated_user");
    expect(await createTokenStore(file, "another-client").load()).toBeNull();
    expect(await readdir(directory)).toEqual(["tokens.json"]);
    expect(JSON.parse(await readFile(file, "utf8")).clientId).toBe(config.clientId);
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
});
