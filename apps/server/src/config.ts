import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const openaiEnvironmentSchema = z.object({
  OPENAI_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => value || undefined),
  CONSENSUS_SERVICE_TIER: z.enum(["default", "fast"]).default("fast"),
  MIN_VOICES: z.coerce.number().int().min(1).max(10).default(2),
});

const voiceEnvironmentSchema = z.object({
  VOICE_PROVIDER: z.enum(["realtime", "legacy"]).default("realtime"),
  MAIN_VOICE: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .default("cedar"),
  WHISPER_VOICE: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .default("sage"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4040),
  SPEND_CAP_USD: z.coerce.number().finite().positive().default(5),
  OPENAI_REALTIME_URL: z
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        /^wss?:$/.test(url.protocol) &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        !url.username &&
        !url.password
      );
    })
    .optional(),
});

export interface VoiceConfig {
  provider: "realtime";
  mainVoice: string;
  dissentVoice: string;
  port: number;
  spendCapUsd: number;
  realtimeUrl?: string;
}

export interface OpenAIConfig {
  apiKey?: string;
  serviceTier: "default" | "fast";
  minVoices: number;
}

const environmentSchema = z.object({
  TWITCH_CLIENT_ID: z.string().trim().min(1),
  TWITCH_CLIENT_SECRET: z.string().min(1),
  TWITCH_CHANNEL: z.string().regex(/^[a-z0-9_]+$/),
  EVENTSUB_URL: z
    .url()
    .refine((value) => /^wss?:/.test(value))
    .default("wss://eventsub.wss.twitch.tv/ws"),
  HELIX_URL: z
    .url()
    .refine((value) => /^https?:/.test(value))
    .default("https://api.twitch.tv/helix"),
  TWITCH_AUTH_URL: z
    .url()
    .refine((value) => /^https?:/.test(value))
    .default("https://id.twitch.tv/oauth2"),
  TOKEN_FILE: z.string().min(1).optional(),
  RECORDINGS_DIR: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
});

export interface Config {
  clientId: string;
  clientSecret: string;
  channel: string;
  eventsubUrl: string;
  helixUrl: string;
  authUrl: string;
  tokenFile: string;
  recordingsDir: string;
  logLevel: z.infer<typeof environmentSchema>["LOG_LEVEL"];
  openai: OpenAIConfig;
  voice: VoiceConfig;
}

function configError(issues: readonly { path: PropertyKey[] }[]): Error {
  const names = [...new Set(issues.map((issue) => issue.path[0]))];
  return new Error(`Invalid or missing configuration: ${names.join(", ")}`);
}

export function loadOpenAIConfig(environment: NodeJS.ProcessEnv = process.env): OpenAIConfig {
  const result = openaiEnvironmentSchema.safeParse(environment);
  if (!result.success) throw configError(result.error.issues);
  return {
    ...(result.data.OPENAI_API_KEY ? { apiKey: result.data.OPENAI_API_KEY } : {}),
    serviceTier: result.data.CONSENSUS_SERVICE_TIER,
    minVoices: result.data.MIN_VOICES,
  };
}

export function requireOpenAIKey(config: OpenAIConfig): string {
  if (!config.apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI requests");
  return config.apiKey;
}

export function loadVoiceConfig(environment: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const result = voiceEnvironmentSchema.safeParse(environment);
  if (!result.success) throw configError(result.error.issues);
  const value = result.data;
  if (value.VOICE_PROVIDER === "legacy")
    throw new Error(
      "VOICE_PROVIDER=legacy is unavailable in this version; use realtime. Failed realtime lines remain caption-only.",
    );
  return {
    provider: "realtime",
    mainVoice: value.MAIN_VOICE,
    dissentVoice: value.WHISPER_VOICE,
    port: value.PORT,
    spendCapUsd: value.SPEND_CAP_USD,
    ...(value.OPENAI_REALTIME_URL ? { realtimeUrl: value.OPENAI_REALTIME_URL } : {}),
  };
}

export function defaultTokenFile(environment: NodeJS.ProcessEnv = process.env): string {
  return process.platform === "win32"
    ? join(
        environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Spokesmob",
        "tokens.json",
      )
    : join(homedir(), ".config", "spokesmob", "tokens.json");
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) throw configError(result.error.issues);
  const value = result.data;
  return {
    clientId: value.TWITCH_CLIENT_ID,
    clientSecret: value.TWITCH_CLIENT_SECRET,
    channel: value.TWITCH_CHANNEL,
    eventsubUrl: value.EVENTSUB_URL,
    helixUrl: value.HELIX_URL.replace(/\/$/, ""),
    authUrl: value.TWITCH_AUTH_URL.replace(/\/$/, ""),
    tokenFile: value.TOKEN_FILE ?? defaultTokenFile(environment),
    recordingsDir:
      value.RECORDINGS_DIR ??
      join(dirname(value.TOKEN_FILE ?? defaultTokenFile(environment)), "recordings"),
    logLevel: value.LOG_LEVEL,
    openai: loadOpenAIConfig(environment),
    voice: loadVoiceConfig(environment),
  };
}
