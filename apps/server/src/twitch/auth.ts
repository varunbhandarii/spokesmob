import type { Logger } from "pino";
import { type Clock, systemClock } from "../clock.js";
import type { Config } from "../config.js";
import {
  AuthError,
  authRequest,
  type Fetch,
  tokenFromGrant,
  validateToken,
} from "./device-flow.js";
import type { StoredToken, TokenStore } from "./token-store.js";

export type AuthState = "ready" | "auth_required";
export interface TokenIdentity {
  userId: string;
  login: string;
  scopes: readonly string[];
  expiresAt: number;
}
export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
  onUnauthorized(rejectedToken?: string): Promise<string>;
  readonly identity: TokenIdentity;
}

export class TokenProvider implements AccessTokenProvider {
  private token: StoredToken | null = null;
  private refreshFlight: Promise<string> | undefined;
  private validationFlight: Promise<void> | undefined;
  private persistenceFlight: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private state: AuthState = "auth_required";
  private readonly clock: Clock;
  private readonly fetcher: Fetch;

  constructor(
    private readonly options: {
      config: Config;
      store: TokenStore;
      fetch?: Fetch;
      clock?: Clock;
      log: Logger;
      onState?: (state: AuthState) => void;
    },
  ) {
    this.clock = options.clock ?? systemClock;
    this.fetcher = options.fetch ?? fetch;
  }

  get identity(): TokenIdentity {
    if (!this.token || this.state !== "ready")
      throw new AuthError("Twitch sign-in required; run npm run setup");
    return {
      userId: this.token.userId,
      login: this.token.login,
      scopes: [...this.token.scopes],
      expiresAt: this.token.expiresAt,
    };
  }

  async start(): Promise<void> {
    this.stop();
    this.token = await this.options.store.load();
    if (!this.token) {
      this.requireSignIn();
      throw new AuthError("Twitch sign-in required; run npm run setup");
    }
    this.state = "ready";
    await this.validate();
    this.timer = this.clock.setInterval(() => {
      void this.validate().catch(() =>
        this.options.log.warn("Twitch authorization requires setup"),
      );
    }, 55 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) this.clock.clearInterval(this.timer);
    this.timer = undefined;
  }

  requireSignIn(): void {
    this.state = "auth_required";
    this.token = null;
    this.stop();
    this.options.onState?.(this.state);
  }

  async getAccessToken(): Promise<string> {
    if (!this.token || this.state !== "ready")
      throw new AuthError("Twitch sign-in required; run npm run setup");
    if (this.refreshFlight) return this.refreshFlight;
    return this.token.expiresAt - this.clock.now() <= 60_000
      ? this.onUnauthorized()
      : this.token.accessToken;
  }

  async onUnauthorized(rejectedToken?: string): Promise<string> {
    if (this.refreshFlight) return this.refreshFlight;
    if (!this.token || this.state !== "ready")
      throw new AuthError("Twitch sign-in required; run npm run setup");
    if (rejectedToken && rejectedToken !== this.token.accessToken) return this.token.accessToken;
    this.refreshFlight = this.refresh().finally(() => {
      this.refreshFlight = undefined;
    });
    return this.refreshFlight;
  }

  private async refresh(): Promise<string> {
    const previous = this.token;
    if (!previous) throw new AuthError("Twitch sign-in required; run npm run setup");
    try {
      const response = await authRequest(this.fetcher, `${this.options.config.authUrl}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: previous.refreshToken,
          client_id: this.options.config.clientId,
          client_secret: this.options.config.clientSecret,
        }),
      });
      if (!response.ok)
        throw new AuthError("Twitch refresh failed; run npm run setup", response.status);
      const next = await tokenFromGrant(
        this.options.config,
        await response.json().catch(() => null),
        this.fetcher,
        this.clock,
      );
      if (next.userId !== previous.userId)
        throw new AuthError("Twitch signed-in user changed; run setup");
      if (!(await this.commit(next, previous)))
        throw new AuthError("Twitch authorization changed during refresh");
      this.options.onState?.("ready");
      this.options.log.info({ userId: next.userId }, "Twitch token refreshed");
      return next.accessToken;
    } catch (error) {
      this.requireSignIn();
      throw error instanceof AuthError
        ? error
        : new AuthError("Twitch refresh failed; run npm run setup");
    }
  }

  validate(): Promise<void> {
    if (this.validationFlight) return this.validationFlight;
    this.validationFlight = this.validateCurrent().finally(() => {
      this.validationFlight = undefined;
    });
    return this.validationFlight;
  }

  private async validateCurrent(): Promise<void> {
    const previous = this.token;
    if (!previous) throw new AuthError("Twitch sign-in required; run npm run setup");
    try {
      const validation = await validateToken(
        this.options.config,
        previous.accessToken,
        this.fetcher,
      );
      if (previous !== this.token) return;
      if (validation.user_id !== previous.userId)
        throw new AuthError("Twitch signed-in user changed; run setup");
      const next = {
        ...previous,
        scopes: validation.scopes,
        login: validation.login,
        expiresAt: this.clock.now() + validation.expires_in * 1000,
      };
      await this.commit(next, previous);
      this.options.onState?.("ready");
    } catch (error) {
      if (error instanceof AuthError && error.status === 401) {
        await this.onUnauthorized(previous.accessToken);
        return;
      }
      this.requireSignIn();
      throw error;
    }
  }

  private commit(next: StoredToken, expected: StoredToken): Promise<boolean> {
    const operation = this.persistenceFlight
      .catch(() => undefined)
      .then(async () => {
        if (this.token !== expected || this.state !== "ready") return false;
        await this.options.store.save(next);
        if (this.state !== "ready") return false;
        this.token = next;
        return true;
      });
    this.persistenceFlight = operation;
    return operation;
  }
}
