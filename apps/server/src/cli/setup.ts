import { pathToFileURL } from "node:url";
import type { Clock } from "../clock.js";
import { type Config, loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { TokenProvider } from "../twitch/auth.js";
import { type Activation, AuthError, deviceFlow, type Fetch } from "../twitch/device-flow.js";
import { HelixClient, HelixError } from "../twitch/helix.js";
import { createTokenStore, type TokenStore } from "../twitch/token-store.js";

export async function setup(
  options: {
    config?: Config;
    fetch?: Fetch;
    clock?: Clock;
    store?: TokenStore;
    output?: (line: string) => void;
    activation?: (activation: Activation) => void;
  } = {},
): Promise<void> {
  const config = options.config ?? loadConfig();
  const output = options.output ?? console.log;
  const log = createLogger(config.logLevel);
  const store = options.store ?? createTokenStore(config.tokenFile, config.clientId);
  const auth = new TokenProvider({
    config,
    store,
    log,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  try {
    try {
      await auth.start();
      output(`Signed in as ${auth.identity.login}`);
      return;
    } catch {
      auth.stop();
    }
    const token = await deviceFlow(
      config,
      options.activation ??
        (({ userCode, verificationUrl }) => {
          output(`Open ${verificationUrl} and enter the activation code: ${userCode}`);
        }),
      {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
      },
    );
    // Resolve the broadcaster before persisting a new authorization.
    const helix = new HelixClient({
      config,
      log,
      auth: {
        identity: token,
        getAccessToken: async () => token.accessToken,
        onUnauthorized: async () => {
          throw new AuthError("Twitch setup authorization was rejected; retry setup");
        },
      },
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
    });
    const channel = (await helix.getUsers({ logins: [config.channel] }))[0];
    if (!channel?.id) throw new Error("Cannot resolve TWITCH_CHANNEL");
    if (channel.id !== token.userId) log.warn("The moderator authorization path is unverified");
    await store.save(token);
    output(
      `Signed in as ${token.login}; channel ${config.channel}; ${token.scopes.length} scopes; expires ${new Date(token.expiresAt).toISOString()}`,
    );
  } finally {
    auth.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setup().catch((error: unknown) => {
    console.error(
      error instanceof AuthError ||
        error instanceof HelixError ||
        (error instanceof Error && error.message.startsWith("Invalid or missing configuration:"))
        ? error.message
        : "Twitch setup failed. Check configuration and authorization, then retry.",
    );
    process.exitCode = 1;
  });
}
