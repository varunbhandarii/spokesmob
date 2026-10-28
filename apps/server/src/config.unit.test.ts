import { expect, test } from "vitest";
import { loadConfig, loadOpenAIConfig, loadVoiceConfig, requireOpenAIKey } from "./config.js";

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

test("offline settings and Twitch configuration accept a missing or empty OpenAI key", () => {
  expect(loadOpenAIConfig({})).toEqual({ serviceTier: "fast", minVoices: 2 });
  expect(loadConfig({ ...environment, OPENAI_API_KEY: "" }).openai).toEqual({
    serviceTier: "fast",
    minVoices: 2,
  });
  expect(() => requireOpenAIKey(loadOpenAIConfig({}))).toThrow("OPENAI_API_KEY is required");
});

test("OpenAI settings preserve explicit tier and support overrides", () => {
  const settings = loadOpenAIConfig({
    OPENAI_API_KEY: "synthetic-key",
    CONSENSUS_SERVICE_TIER: "default",
    MIN_VOICES: "1",
  });
  expect(settings).toEqual({ apiKey: "synthetic-key", serviceTier: "default", minVoices: 1 });
  expect(requireOpenAIKey(settings)).toBe("synthetic-key");
});

test("invalid consensus settings identify variables without exposing values", () => {
  expect(() =>
    loadOpenAIConfig({ CONSENSUS_SERVICE_TIER: "private-invalid-tier", MIN_VOICES: "11" }),
  ).toThrow("Invalid or missing configuration: CONSENSUS_SERVICE_TIER, MIN_VOICES");
  for (const value of ["0", "2.5", "NaN", ""])
    expect(() => loadOpenAIConfig({ MIN_VOICES: value })).toThrow("MIN_VOICES");
});

test("voice settings work without credentials and preserve supported overrides", () => {
  expect(loadVoiceConfig({})).toEqual({
    provider: "realtime",
    mainVoice: "cedar",
    dissentVoice: "sage",
    port: 4040,
    spendCapUsd: 5,
  });
  expect(loadConfig(environment).voice).toEqual(loadVoiceConfig({}));
  expect(
    loadVoiceConfig({
      MAIN_VOICE: "marin",
      WHISPER_VOICE: "cedar",
      PORT: "5050",
      SPEND_CAP_USD: "2.50",
    }),
  ).toEqual({
    provider: "realtime",
    mainVoice: "marin",
    dissentVoice: "cedar",
    port: 5050,
    spendCapUsd: 2.5,
  });
});

test("legacy selection fails clearly and invalid settings never expose values", () => {
  expect(() => loadVoiceConfig({ VOICE_PROVIDER: "legacy" })).toThrow(
    "unavailable in this version",
  );
  expect(() => loadConfig({ ...environment, VOICE_PROVIDER: "legacy" })).toThrow("caption-only");
  expect(() =>
    loadVoiceConfig({ MAIN_VOICE: "private-invalid-value!", PORT: "65536", SPEND_CAP_USD: "NaN" }),
  ).toThrow("Invalid or missing configuration: MAIN_VOICE, PORT, SPEND_CAP_USD");
  for (const PORT of ["0", "1.5", "NaN", ""])
    expect(() => loadVoiceConfig({ PORT })).toThrow("PORT");
  for (const SPEND_CAP_USD of ["-1", "0", "Infinity", ""])
    expect(() => loadVoiceConfig({ SPEND_CAP_USD })).toThrow("SPEND_CAP_USD");
});
