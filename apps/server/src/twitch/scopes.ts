export const TWITCH_SCOPES = Object.freeze([
  "user:read:chat",
  "user:write:chat",
  "user:bot",
  "channel:bot",
  "moderator:manage:announcements",
  "moderator:manage:chat_messages",
  "moderator:manage:chat_settings",
  "moderator:read:chatters",
  "moderator:read:blocked_terms",
  "clips:edit",
  "channel:manage:broadcast",
  "channel:read:hype_train",
  "channel:manage:redemptions",
  "channel:manage:polls",
] as const);

export function requireScopes(scopes: readonly string[]): void {
  const missing = TWITCH_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new Error(`Missing Twitch scopes: ${missing.join(", ")}`);
}
