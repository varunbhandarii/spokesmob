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
import { CommandRouter } from "./commands.js";
import { FakeVoice } from "./fakes.js";
import { publishHealth } from "./health.js";
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
  stubVoice?: boolean;
  headless?: boolean;
  budgetLimitUsd?: number;
  apiFailure?(source: "model" | "voice"): void;
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
  let commands: CommandRouter | undefined;
  try {
    store = openApplicationStore({
      tokenFile: config.tokenFile,
      ...(config.databaseFile ? { file: config.databaseFile } : {}),
      retentionDays: config.beat.logRetentionDays,
      ...(options.clock ? { clock: options.clock } : {}),
    });
    const sessionId = randomUUID();
    const ledger = new SpendLedger(
      store.costLedger,
      sessionId,
      config.beat.spendCapUsd,
      options.budgetLimitUsd,
    );
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
      updated: (beatId) => {
        if (beatId) runner?.records.reconcileCost(beatId);
        runner?.publishCost();
      },
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
      checkAllowed: () =>
        !!runner &&
        !runner.state.muted &&
        !runner.state.gates.killed &&
        runner.state.step !== "preview" &&
        runner.state.step !== "speaking" &&
        runner.state.step !== "synthesizing",
    });
    const hub = voice.http.hub;
    const fakeVoice = options.stubVoice ? new FakeVoice(options.clock) : null;
    const output = new ChatOutput(twitch.helix, log);
    runner = new BeatRunner({
      bus: twitch.bus,
      online: twitch.online,
      store,
      ledger,
      settings: config.beat,
      sessionId,
      voice: fakeVoice ?? voice.manager,
      output,
      model,
      moderation,
      blocklist: twitch.blocklist,
      clients: () => ({
        audioConnected: options.headless && fakeVoice ? true : hub.audioConnected,
        audioActive: options.headless && fakeVoice ? true : hub.audioActive,
        overlayConnected: options.headless && fakeVoice ? true : hub.hasOverlayClient,
      }),
      overlay: (message) => hub.emitOverlay(message),
      control: (message) => hub.emitControl(message),
      log,
      tier: config.openai.serviceTier,
      paidModel: options.paidModel ?? true,
      paidVoice: options.paidVoice ?? true,
      simulated: !!fakeVoice,
      ...(options.apiFailure ? { apiFailure: options.apiFailure } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
    const beat = runner;
    if (fakeVoice) fakeVoice.onReport = (event) => beat.report(event);
    commands = new CommandRouter({
      runner: beat,
      store,
      ledger,
      output,
      moderation,
      blocklist: twitch.blocklist,
      bus: twitch.bus,
      log,
      retention: () => store?.prune(),
      ...(options.clock ? { clock: options.clock } : {}),
    });
    const router = commands;
    voice.http.setControl({
      state: () => ({ state: beat.view(), settings: beat.state.settings }),
      logs: (limit, before) => store?.beatLog.recent(limit, before) ?? [],
      execute: (command) => router.execute(command),
    });
    hub.setSnapshot(() => beat.view());
    hub.onAction((command) => router.execute(command));
    const unobserve = hub.observe((event) => beat.report(event));
    const unclients = hub.onClients(() => {
      beat.refreshClients();
      beat.publishCost();
    });
    const stopHealth = publishHealth({
      bus: twitch.bus,
      hub,
      voice: voice.manager,
      store,
      clock: options.clock ?? systemClock,
    });
    const runtimeVoice = voice;
    const runtimeStore = store;
    return {
      config,
      sessionId,
      twitch,
      voice: runtimeVoice,
      runner: beat,
      store: runtimeStore,
      ledger,
      commands: router,
      async start() {
        const path = await runtimeVoice.start();
        // Connect and configure only: no prompt, input audio or response generation.
        const warm = async (source: string, connect: () => Promise<void> | undefined) => {
          try {
            await connect();
          } catch {
            log.warn({ source }, "Connection warm-up unavailable; connecting on demand");
          }
        };
        await Promise.all([
          warm("model", () => model.warmup?.()),
          warm("voice", () => (options.stubVoice ? undefined : runtimeVoice.manager.start())),
        ]);
        beat.start();
        twitch.client.start();
        return path;
      },
      async close() {
        router.stop();
        stopHealth();
        unclients();
        unobserve();
        await beat.stop();
        await runtimeVoice.close();
        await twitch.stop();
        runtimeStore.close();
      },
    };
  } catch (error) {
    commands?.stop();
    await runner?.stop();
    await voice?.close();
    await twitch.stop();
    store?.close();
    throw error;
  }
}
