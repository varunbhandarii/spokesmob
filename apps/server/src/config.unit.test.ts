import { expect, test } from "vitest";
import { loadConfig } from "./config.js";

const environment = {
  TWITCH_CLIENT_ID: "demo-client",
  TWITCH_CLIENT_SECRET: "private-fixture",
  TWITCH_CHANNEL: "demo_channel",
};

test("configuration errors name variables without including their values", () => {
  expect(() => loadConfig({ TWITCH_CHANNEL: "value-to-keep-private!" })).toThrow(
    "Invalid or missing configuration: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_CHANNEL",
  );
});

test("service URLs accept local overrides and reject unrelated protocols", () => {
  const config = loadConfig({
    ...environment,
    EVENTSUB_URL: "ws://localhost:8080/ws",
    HELIX_URL: "http://localhost:8080/helix/",
    TWITCH_AUTH_URL: "http://localhost:8080/oauth2/",
    TOKEN_FILE: "test-results/tokens.json",
  });
  expect(config.eventsubUrl).toBe("ws://localhost:8080/ws");
  expect(config.helixUrl).toBe("http://localhost:8080/helix");
  expect(config.authUrl).toBe("http://localhost:8080/oauth2");
  expect(config.tokenFile).toBe("test-results/tokens.json");
  expect(() => loadConfig({ ...environment, HELIX_URL: "file:///private" })).toThrow("HELIX_URL");
});
