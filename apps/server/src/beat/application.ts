import { randomUUID } from "node:crypto";
import { OpenAI } from "openai";
import type { Logger } from "pino";
import { type Clock, systemClock } from "../clock.js";
import type { Config } from "../config.js";
import { requireOpenAIKey } from "../config.js";
import { OpenAIConsensusModel, OpenAIModerationPort } from "../consensus/model.js";
import type { ConsensusModelPort, ModerationPort } from "../consensus/ports.js";
import { openApplicationStore } from "../store/application.js";
import { SpendLedger } from "../store/spend.js";
import { createTwitchRuntime, type TwitchRuntime } from "../twitch/runtime.js";
import { createVoiceRuntime } from "../voice/runtime.js";
import type { RealtimeFactory } from "../voice/transport.js";
import { recordedModeration } from "./billing.js";
import { ChatOutput } from "./output.js";
import { BeatRunner } from "./runner.js";

export async function createBeatApplication(options: {
  config: Config;
  log: Logger;
  twitch?: TwitchRuntime;
  model?: ConsensusModelPort;
  moderation?: ModerationPort;
  factory?: RealtimeFactory;
  clock?: Clock;
  paidModel?: boolean;
  paidVoice?: boolean;
}) {
  const { config, log } = options;
  const twitch =
    options.twitch ??
    (await createTwitchRuntime({
      config,
      log,
      ...(options.clock ? { clock: options.clock } : {}),
    }));
  let store: ReturnType<typeof openApplicationStore> | undefined;
  let voice: Awaited<ReturnType<typeof createVoiceRuntime>> | undefined;
  let runner: BeatRunner | undefined;
  try {
    store = openApplicationStore({
      tokenFile: config.tokenFile,
      ...(config.databaseFile ? { file: config.databaseFile } : {}),
      retentionDays: config.beat.logRetentionDays,
      ...(options.clock ? { clock: options.clock } : {}),
    });
    const sessionId = randomUUID();
    const ledger = new SpendLedger(store.costLedger, sessionId, config.beat.spendCapUsd);
    const client =
      options.model && options.moderation
        ? null
        : new OpenAI({ apiKey: requireOpenAIKey(config.openai), maxRetries: 0 });
    const model =
      options.model ??
      new OpenAIConsensusModel({
        client: client as OpenAI,
        serviceTier: config.openai.serviceTier,
        ...(options.clock ? { clock: options.clock } : {}),
      });
    const moderation = recordedModeration({
      port: options.moderation ?? new OpenAIModerationPort(client as OpenAI),
      ledger,
      clock: options.clock ?? systemClock,
      beatId: () => (runner?.state.current ? runner.records.key(runner.state.current.id) : null),
      updated: () => runner?.publishCost(),
    });
    voice = await createVoiceRuntime({
      tokenFile: config.tokenFile,
      voice: config.voice,
      openai: config.openai,
      log,
      blocklist: twitch.blocklist,
      moderation,
      ...(options.factory ? { factory: options.factory } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      allowAttempt: (take, attempt) => runner?.allowVoiceAttempt(take, attempt) ?? false,
      onUsage: (take, attempt, usage, cost) => runner?.voiceUsage(take, attempt, usage, cost),
    });
    const hub = voice.http.hub;
    runner = new BeatRunner({
      bus: twitch.bus,
      online: twitch.online,
      store,
      ledger,
      settings: config.beat,
      sessionId,
      voice: voice.manager,
      output: new ChatOutput(twitch.helix, log),
      model,
      moderation,
      blocklist: twitch.blocklist,
      clients: () => ({
        audioConnected: hub.audioConnected,
        audioActive: hub.audioActive,
        overlayConnected: hub.hasOverlayClient,
      }),
      overlay: (message) => hub.emitOverlay(message),
      log,
      tier: config.openai.serviceTier,
      paidModel: options.paidModel ?? true,
      paidVoice: options.paidVoice ?? true,
      ...(options.clock ? { clock: options.clock } : {}),
    });
    const beat = runner;
    const unobserve = hub.observe((event) => beat.report(event));
    const unclients = hub.onClients(() => beat.refreshClients());
    const runtimeVoice = voice;
    const runtimeStore = store;
    return {
      config,
      twitch,
      voice: runtimeVoice,
      runner: beat,
      store: runtimeStore,
      ledger,
      async start() {
        const path = await runtimeVoice.start();
        beat.start();
        twitch.client.start();
        return path;
      },
      async close() {
        unclients();
        unobserve();
        await beat.stop();
        await runtimeVoice.close();
        await twitch.stop();
        runtimeStore.close();
      },
    };
  } catch (error) {
    await runner?.stop();
    await voice?.close();
    await twitch.stop();
    store?.close();
    throw error;
  }
}
