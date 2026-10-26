---
name: helix-call
description: Add or review a typed Twitch Helix wrapper in Spokesmob, including rate class, retry behavior, mock route and contract tests.
---

# Add a Helix wrapper

Use the official [Helix reference](https://dev.twitch.tv/docs/api/reference/) for exact HTTP methods, query/body fields, scopes and limits. Inspect `apps/server/src/twitch/helix.ts` before adding an endpoint.

- Add a typed wrapper to `HelixClient`, routed through its existing `request` method and shared limiter. Fill broadcaster, moderator and sender IDs from the resolved channel and token identity. Request only the already approved scopes.
- Choose `chat`, `announce` or `general` rate class and explicitly decide idempotency. Chat messages and announcements never auto-retry, including on 401 or 429. Other non-idempotent writes must not gain retries accidentally.
- For idempotent calls, preserve the existing policy: refresh/retry once on 401; wait for reset/retry once on 429 only if remaining capacity is zero or absent; retry 5xx up to three times with 500 ms doubling delays. Surface other errors.
- Validate local bounds before I/O. Treat chat drop codes as opaque. A missing send entry is not sent; never pin an unconfirmed or dropped message. Pinning uses a separate request, without `pin: true` or user-token `for_source_only`.
- Add the route to `tools/mock-eventsub/src/services.ts` and test the contract against that mock, including relevant negative results and fake-clock retry/rate timing. Tests never contact Twitch or a paid service.
- Logs show status, endpoint, IDs and counts. Never propagate provider response bodies, authorization headers, tokens, secrets or device credentials into logs or errors.
- Update the README for visible settings or behavior, then run typecheck, tests and lint.
