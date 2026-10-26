import { pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { TokenProvider } from "../twitch/auth.js";
import { deviceFlow } from "../twitch/device-flow.js";
import { createTokenStore } from "../twitch/token-store.js";

export async function setup(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const store = createTokenStore(config.tokenFile, config.clientId);
  const auth = new TokenProvider({ config, store, log });
  try {
    try {
      await auth.start();
      console.log(`Signed in as ${auth.identity.login}`);
      return;
    } catch {
      auth.stop();
    }
    const token = await deviceFlow(config, ({ userCode, verificationUrl }) => {
      console.log(`Open ${verificationUrl} and enter the activation code: ${userCode}`);
    });
    // Resolve the broadcaster before persisting a new authorization.
    const url = new URL(`${config.helixUrl}/users`);
    url.searchParams.set("login", config.channel);
    const response = await fetch(url, {
      headers: { "Client-Id": config.clientId, Authorization: `Bearer ${token.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json()) as { data?: { id: string; login: string }[] };
    const channel = data.data?.[0];
    if (!response.ok || !channel?.id) throw new Error("Cannot resolve TWITCH_CHANNEL");
    if (channel.id !== token.userId) log.warn("The moderator authorization path is unverified");
    await store.save(token);
    console.log(
      `Signed in as ${token.login}; channel ${config.channel}; ${token.scopes.length} scopes; expires ${new Date(token.expiresAt).toISOString()}`,
    );
  } finally {
    auth.stop();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  setup().catch(() => {
    console.error("Twitch setup failed. Check configuration and authorization, then retry.");
    process.exitCode = 1;
  });
}
