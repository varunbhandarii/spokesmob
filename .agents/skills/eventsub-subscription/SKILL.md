---
name: eventsub-subscription
description: Add or review Twitch EventSub WebSocket subscriptions in Spokesmob, including payload mapping, local mock support and replay coverage.
---

# Add an EventSub subscription

Read the existing registry in `apps/server/src/twitch/subscriptions.ts` and mapping in `events.ts`. Reuse existing pieces when a payload or scenario is already supported.

1. Check the official [subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/) and [payload reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/) for the exact version, scopes and condition fields. Compare scopes with `apps/server/src/twitch/scopes.ts`; ask before adding a scope.
2. Add the spec and condition builder to `subscriptionSpecs`. Chat conditions use the token user's `user_id`; incoming raids use `to_broadcaster_user_id`. Use the existing connection manager and Helix client for registration.
3. Add or extend a passthrough zod payload schema and a case in `mapNotification`, with a typed `TwitchEvent` result. Unknown fields must not make valid events fail. Malformed payloads are logged without their contents and dropped.
4. Extend `tools/mock-eventsub/src/scenario.ts` and a synthetic JSONL fixture. Check the envelope type/version as well as the event shape. Keep real viewer identities and unconsented message text out of fixtures.
5. Cover mapping in `events.unit.test.ts` and delivery through the mock in `twitch.replay.test.ts`. Prefer behavior and replay assertions over matching implementation text. Tests use fake clocks and the project mock, with no external requests.
6. Add a README line if users see the new event. Run typecheck, tests and lint; keep the complete test command under 60 seconds.

Keep transport behavior in `eventsub.ts`: parallel welcome subscriptions, shared deduplication, and no resubscription during a server-directed handover. Adding a type must not create another socket or bypass that manager.
