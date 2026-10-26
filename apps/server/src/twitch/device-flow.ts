import { z } from "zod";
import { type Clock, sleep, systemClock } from "../clock.js";
import type { Config } from "../config.js";
import { requireScopes, TWITCH_SCOPES } from "./scopes.js";
import type { StoredToken } from "./token-store.js";

export type Fetch = typeof globalThis.fetch;
export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const grantSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive(),
});
const validationSchema = z.object({
  client_id: z.string(),
  user_id: z.string().min(1),
  login: z.string().min(1),
  scopes: z.array(z.string()),
  expires_in: z.number().nonnegative(),
});

export async function authRequest(
  fetcher: Fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new AuthError("Twitch authorization request failed");
  }
}

export async function validateToken(
  config: Config,
  accessToken: string,
  fetcher: Fetch,
): Promise<z.infer<typeof validationSchema>> {
  const response = await authRequest(fetcher, `${config.authUrl}/validate`, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!response.ok) throw new AuthError("Twitch token validation failed", response.status);
  const parsed = validationSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AuthError("Invalid Twitch validation response");
  if (parsed.data.client_id !== config.clientId)
    throw new AuthError("Twitch token client mismatch");
  requireScopes(parsed.data.scopes);
  return parsed.data;
}

export async function tokenFromGrant(
  config: Config,
  data: unknown,
  fetcher: Fetch,
  clock: Clock,
): Promise<StoredToken> {
  const grant = grantSchema.safeParse(data);
  if (!grant.success) throw new AuthError("Invalid Twitch token response");
  const identity = await validateToken(config, grant.data.access_token, fetcher);
  return {
    accessToken: grant.data.access_token,
    refreshToken: grant.data.refresh_token,
    obtainedAt: clock.now(),
    expiresAt: clock.now() + Math.min(grant.data.expires_in, identity.expires_in) * 1000,
    scopes: identity.scopes,
    userId: identity.user_id,
    login: identity.login,
    clientId: identity.client_id,
  };
}

export interface Activation {
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}
export async function deviceFlow(
  config: Config,
  showActivation: (activation: Activation) => void,
  options: { fetch?: Fetch; clock?: Clock } = {},
): Promise<StoredToken> {
  const fetcher = options.fetch ?? fetch;
  const clock = options.clock ?? systemClock;
  const response = await authRequest(fetcher, `${config.authUrl}/device`, {
    method: "POST",
    body: new URLSearchParams({ client_id: config.clientId, scopes: TWITCH_SCOPES.join(" ") }),
  });
  if (!response.ok) throw new AuthError("Twitch activation request failed", response.status);
  const parsed = z
    .object({
      device_code: z.string().min(1),
      user_code: z.string().min(1),
      verification_uri: z.url(),
      expires_in: z.number().positive(),
      interval: z.number().positive().default(5),
    })
    .safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AuthError("Invalid Twitch activation response");
  const grant = parsed.data;
  // Only the human activation code crosses this boundary. The device credential stays here.
  const expiresAt = clock.now() + grant.expires_in * 1000;
  showActivation({ userCode: grant.user_code, verificationUrl: grant.verification_uri, expiresAt });
  let interval = grant.interval * 1000;
  while (clock.now() < expiresAt) {
    await sleep(clock, Math.min(interval, expiresAt - clock.now()));
    if (clock.now() >= expiresAt) break;
    const poll = await authRequest(fetcher, `${config.authUrl}/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: config.clientId,
        scopes: TWITCH_SCOPES.join(" "),
        device_code: grant.device_code,
      }),
    });
    const data: unknown = await poll.json().catch(() => null);
    if (poll.ok) return tokenFromGrant(config, data, fetcher, clock);
    const error = z
      .object({ message: z.string().optional(), error: z.string().optional() })
      .safeParse(data);
    const code = error.success ? (error.data.message ?? error.data.error) : undefined;
    if (code === "authorization_pending") continue;
    if (code === "slow_down" || poll.status === 429) {
      interval += 5000;
      continue;
    }
    if (code === "expired_token") break;
    throw new AuthError("Twitch activation was denied or failed", poll.status);
  }
  throw new AuthError("Twitch activation expired; run setup again");
}
