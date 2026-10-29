import type { Clock } from "../clock.js";
import type { OverlayHub } from "../http/ws-hub.js";
import type { Repositories } from "../store/repositories.js";
import type { SessionState, TwitchBus } from "../twitch/bus.js";
import type { VoiceManager } from "../voice/manager.js";

export function publishHealth(options: {
  bus: TwitchBus;
  hub: OverlayHub;
  voice: VoiceManager;
  store: Repositories;
  clock: Clock;
}) {
  let auth = true;
  let state: SessionState = "idle";
  const subscriptions = new Map<string, boolean>();
  const publish = () => {
    const health = options.voice.health();
    options.hub.emitControl({
      type: "health",
      twitchAuth: { ok: auth },
      eventSub: { connected: state === "ready" || state === "reconnecting", state },
      subscriptions: {
        enabled: [...subscriptions.values()].filter(Boolean).length,
        total: subscriptions.size,
      },
      realtime: { main: health.main, dissent: health.dissent },
      audioClient: { connected: options.hub.audioConnected, active: options.hub.audioActive },
      e2eMs: options.store.beatLog.recent(200).find((row) => row.e2eMs !== null)?.e2eMs ?? null,
    });
  };
  const stopHealth = options.bus.onHealth((event) => {
    if (event.kind === "auth") auth = event.state === "ready";
    if (event.kind === "session") {
      state = event.state;
      if (state === "subscribing" || state === "idle" || state === "backoff") subscriptions.clear();
    }
    if (event.kind === "subscription") subscriptions.set(event.type, event.status === "enabled");
    publish();
  });
  const stopClients = options.hub.onClients(publish);
  const timer = options.clock.setInterval(publish, 1000);
  return () => {
    stopHealth();
    stopClients();
    options.clock.clearInterval(timer);
  };
}
