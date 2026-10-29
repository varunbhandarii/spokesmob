import { OpenAI } from "openai";
import type { Logger } from "pino";
import type { Scenario } from "../../../../tools/mock-eventsub/src/scenario.js";
import { createMockServer } from "../../../../tools/mock-eventsub/src/server.js";
import { createMockServices } from "../../../../tools/mock-eventsub/src/services.js";
import type { Config } from "../config.js";
import { requireOpenAIKey } from "../config.js";
import { FakeModerationPort } from "../consensus/fakes.js";
import { OpenAIConsensusModel, OpenAIModerationPort } from "../consensus/model.js";
import { StubConsensusModel } from "../consensus/stub-model.js";
import { createTwitchRuntime } from "../twitch/runtime.js";
import type { StoredToken } from "../twitch/token-store.js";
import { createBeatApplication } from "./application.js";

export interface MockLoop {
  application: Awaited<ReturnType<typeof createBeatApplication>>;
  mock: Awaited<ReturnType<typeof createMockServer>>;
  services: ReturnType<typeof createMockServices>;
  start(): Promise<string>;
  close(): Promise<void>;
}
export async function createMockLoop(options: {
  config: Config;
  scenario: Scenario;
  log: Logger;
  liveModel: boolean;
  liveVoice: boolean;
  headless: boolean;
  budgetLimitUsd: number;
  loop?: boolean;
  apiFailure?(source: "model" | "voice" | "moderation"): void;
}): Promise<MockLoop> {
  if (options.headless && (options.liveModel || options.liveVoice))
    throw new Error("Headless mode requires both stubs");
  const services = createMockServices({ online: true });
  const mock = await createMockServer({
    services,
    scenario: options.scenario,
    autoPlay: false,
    loop: options.loop ?? true,
  });
  let app: Awaited<ReturnType<typeof createBeatApplication>> | undefined;
  let twitch: Awaited<ReturnType<typeof createTwitchRuntime>> | undefined;
  try {
    const config: Config = {
      ...options.config,
      clientId: "mock-client",
      clientSecret: "synthetic-secret",
      channel: "spokesmob_demo",
      eventsubUrl: mock.wsUrl,
      helixUrl: mock.helixUrl,
      authUrl: mock.authUrl,
    };
    let token: StoredToken = {
      accessToken: services.auth.accessToken,
      refreshToken: services.auth.refreshToken,
      scopes: [...services.auth.scopes],
      userId: services.auth.userId,
      login: services.auth.login,
      clientId: config.clientId,
      obtainedAt: Date.now(),
      expiresAt: Date.now() + 3600000,
    };
    twitch = await createTwitchRuntime({
      config,
      log: options.log,
      fetch: services.fetch,
      store: {
        load: async () => token,
        save: async (value) => {
          token = value;
        },
      },
    });
    const paid = options.liveModel || options.liveVoice;
    const client = paid
      ? new OpenAI({ apiKey: requireOpenAIKey(config.openai), maxRetries: 0 })
      : null;
    const model = options.liveModel
      ? new OpenAIConsensusModel({
          client: client as OpenAI,
          serviceTier: config.openai.serviceTier,
        })
      : new StubConsensusModel();
    const baseModeration = paid
      ? new OpenAIModerationPort(client as OpenAI)
      : new FakeModerationPort();
    const moderation = {
      async moderate(texts: readonly string[], signal?: AbortSignal) {
        try {
          const response = await baseModeration.moderate(texts, signal);
          if (response.results.length !== texts.length) options.apiFailure?.("moderation");
          return { ...response, ...(!paid ? { costUsd: 0 } : {}) };
        } catch (error) {
          if (!signal?.aborted) options.apiFailure?.("moderation");
          throw error;
        }
      },
    };
    app = await createBeatApplication({
      config,
      twitch,
      log: options.log,
      model,
      moderation,
      stubVoice: !options.liveVoice,
      headless: options.headless,
      paidModel: options.liveModel,
      paidVoice: options.liveVoice,
      budgetLimitUsd: options.budgetLimitUsd,
      ...(options.apiFailure ? { apiFailure: options.apiFailure } : {}),
    });
    const application = app;
    let ready = false;
    let started = false;
    let played = false;
    const maybePlay = () => {
      if (started && ready && !played && !application.runner.view().heldBy.length) {
        played = true;
        mock.play();
      }
    };
    const stopState = application.runner.onState(maybePlay);
    const stopHealth = twitch.bus.onHealth((event) => {
      if (event.kind === "session" && event.state === "ready") {
        ready = true;
        maybePlay();
      }
    });
    return {
      application,
      mock,
      services,
      async start() {
        const path = await application.start();
        started = true;
        maybePlay();
        return path;
      },
      async close() {
        stopState();
        stopHealth();
        await application.close();
        await mock.close();
      },
    };
  } catch (error) {
    if (app) await app.close();
    else await twitch?.stop();
    await mock.close();
    throw error;
  }
}
