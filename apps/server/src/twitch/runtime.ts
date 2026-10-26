import type { Logger } from "pino";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import { TokenProvider } from "./auth.js";
import { TwitchBus } from "./bus.js";
import type { Fetch } from "./device-flow.js";
import type { EventSubFrame } from "./events.js";
import { EventSubClient } from "./eventsub.js";
import { HelixClient } from "./helix.js";
import { createTokenStore, type TokenStore } from "./token-store.js";

export async function createTwitchRuntime(options: {
  config: Config;
  log: Logger;
  fetch?: Fetch;
  clock?: Clock;
  store?: TokenStore;
  onRaw?: (frame: EventSubFrame) => void;
}) {
  const bus = new TwitchBus();
  let client: EventSubClient | undefined;
  const injected = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  };
  const auth = new TokenProvider({
    ...injected,
    config: options.config,
    log: options.log,
    store: options.store ?? createTokenStore(options.config.tokenFile, options.config.clientId),
    onState: (state) => {
      bus.health({ kind: "auth", state });
      if (state === "auth_required") void client?.stop();
    },
  });
  try {
    await auth.start();
    const helix = new HelixClient({ ...injected, config: options.config, log: options.log, auth });
    const channel = (await helix.getUsers({ logins: [options.config.channel] }))[0];
    if (!channel) throw new Error("Cannot resolve TWITCH_CHANNEL");
    helix.setChannel(channel.id);
    client = new EventSubClient({
      config: options.config,
      log: options.log,
      auth,
      helix,
      bus,
      channelId: channel.id,
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.onRaw ? { onRaw: options.onRaw } : {}),
    });
    return {
      auth,
      helix,
      client,
      channel,
      bus,
      stop: async () => {
        auth.stop();
        await client?.stop();
      },
    };
  } catch (error) {
    auth.stop();
    throw error;
  }
}

export type TwitchRuntime = Awaited<ReturnType<typeof createTwitchRuntime>>;
