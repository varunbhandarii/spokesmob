import { OpenAI } from "openai";
import type { Logger } from "pino";
import { type Blocklist, createBlocklist } from "../../../../packages/core/src/blocklist.js";
import { verifyTemplated } from "../../../../packages/core/src/verify.js";
import { type Clock, sleep, systemClock } from "../clock.js";
import type { OpenAIConfig, VoiceConfig } from "../config.js";
import { OpenAIModerationPort } from "../consensus/model.js";
import type { ModerationPort } from "../consensus/ports.js";
import { loadOverlayToken, saveOverlayUrl } from "../http/overlay-token.js";
import { createHttpServer } from "../http/server.js";
import { VoiceManager } from "./manager.js";
import { type RealtimeFactory, realtimeFactory } from "./transport.js";

export async function createVoiceRuntime(options: {
  tokenFile: string;
  channel?: string;
  voice: VoiceConfig;
  openai: OpenAIConfig;
  log: Logger;
  blocklist?: Blocklist;
  factory?: RealtimeFactory;
  moderation?: ModerationPort;
  overlayRoot?: string;
  allowAttempt?: NonNullable<ConstructorParameters<typeof VoiceManager>[0]["allowAttempt"]>;
  onUsage?: NonNullable<ConstructorParameters<typeof VoiceManager>[0]["onUsage"]>;
  checkAllowed?(): boolean;
  clock?: Clock;
}) {
  const clock = options.clock ?? systemClock;
  const { token } = await loadOverlayToken(options.tokenFile);
  const http = await createHttpServer({
    token,
    port: options.voice.port,
    log: options.log,
    ...(options.overlayRoot ? { overlayRoot: options.overlayRoot } : {}),
  });
  http.hub.setChannel(options.channel ?? "spokesmob");
  const factory =
    options.factory ?? realtimeFactory(options.openai.apiKey ?? "", options.voice.realtimeUrl);
  const manager = new VoiceManager({
    mainVoice: options.voice.mainVoice,
    dissentVoice: options.voice.dissentVoice,
    factory,
    transport: http.hub,
    log: options.log,
    ...(options.allowAttempt ? { allowAttempt: options.allowAttempt } : {}),
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    clock,
  });
  const blocklist = options.blocklist ?? createBlocklist();
  const moderation =
    options.moderation ??
    (options.openai.apiKey
      ? new OpenAIModerationPort(new OpenAI({ apiKey: options.openai.apiKey, maxRetries: 0 }))
      : null);
  http.hub.onReport((event) => manager.report(event));
  let busy = false;
  http.hub.onCommand((command, reply) => {
    const send = (data: unknown) => reply({ type: "voice_result", request: command.request, data });
    if (busy) {
      send({ status: "rejected", reason: "voice_check_busy" });
      return;
    }
    if (options.checkAllowed && !options.checkAllowed()) {
      send({ status: "rejected", reason: "beat_in_progress" });
      return;
    }
    busy = true;
    void (async () => {
      if (!http.hub.hasAudioClient) {
        send({ status: "rejected", reason: "audio_client_required" });
        return;
      }
      if (command.mode !== "tone") {
        const line =
          command.mode === "kill_test"
            ? "A lot of chat would like to try the left path again while a few people prefer the other route."
            : command.text;
        if (!line || !moderation) {
          send({ status: "rejected", reason: "voice_configuration_required" });
          return;
        }
        if (blocklist.check(line).blocked) {
          send({ status: "rejected", reason: "blocked_term" });
          return;
        }
        const response = await moderation.moderate([line]);
        const item = response.results[0];
        const verified = verifyTemplated(line, {
          blocklist,
          moderation:
            response.results.length === 1 && item
              ? {
                  status: "ok",
                  flagged: item.flagged || Object.values(item.categories).some(Boolean),
                }
              : { status: "error" },
        });
        if (!verified.ok) {
          send({ status: "rejected", reason: verified.failures[0] });
          return;
        }
        const start = clock.now();
        const take = manager.prepare(line, command.dissent ? "dissent" : "main");
        await sleep(clock, 1000);
        const result = await take.ready;
        if (result.status !== "verified") {
          send({ ...result, readyMs: clock.now() - start });
          return;
        }
        let playbackStartedAt: number | null = null;
        let silenceMs: number | null = null;
        let killedAt: number | null = null;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const unobserve = http.hub.observe((event) => {
          if (event.take !== take.id) return;
          if (event.type === "started") {
            playbackStartedAt = clock.now();
            if (command.mode === "kill_test")
              killTimer = clock.setTimeout(() => {
                killedAt = clock.now();
                manager.cancelAll();
              }, 1000);
          } else if (event.type === "stopped" && killedAt !== null)
            silenceMs = clock.now() - killedAt;
        });
        try {
          await take.play();
          await take.ended;
          if (command.mode === "kill_test") await sleep(clock, 250);
          send({
            ...result,
            readyMs: (result.verifiedAtMs ?? start) - start,
            playbackStartMs: playbackStartedAt === null ? null : playbackStartedAt - start,
            silenceMs,
          });
        } finally {
          if (killTimer) clock.clearTimeout(killTimer);
          unobserve();
        }
      } else {
        const take = manager.prepareTestTone();
        await take.play();
        const ended = await take.ended;
        send({ ...take.result, playback: ended.reason });
      }
    })()
      .catch(() => send({ status: "rejected", reason: "voice_check_failed" }))
      .finally(() => {
        busy = false;
      });
  });
  return {
    manager,
    http,
    async start() {
      await http.listen();
      const address = http.app.server.address();
      if (!address || typeof address === "string")
        throw new Error("Local server address unavailable");
      const saved = await saveOverlayUrl(options.tokenFile, address.port, token);
      return saved.path;
    },
    async close() {
      manager.close();
      await http.close();
    },
  };
}
