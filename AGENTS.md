# AGENTS.md

## What this is
Spokesmob is a local Node 24 + TypeScript service plus an OBS browser-source overlay that turns a Twitch chat into one spoken voice. Every few seconds it clusters what chat wrote, counts how many people said each thing, and speaks one verified line that paraphrases only what many chatters said. It shows the agreement percentage and whispers the strongest dissent. It has no opinions, no memory and no personality beyond phrasing.

## Stack and layout
- npm workspaces:
  - `apps/server`: Fastify + ws
  - `apps/overlay`: Vite, no framework, Canvas 2D + SVG
  - `apps/control`: Vite
  - `packages/core`: pure logic, no I/O
  - `tools/*`: mock EventSub server, recorder, crowd simulator
  - `eval/`: golden windows + runner
- TypeScript 7 strict, used for type-checking only (`tsc -b`). Vite, tsx and Vitest transpile.
- Biome for lint and format. Do not add ESLint, because TypeScript 7 has no compiler API.
- Other libraries: ESM, zod 4, Vitest 5, Playwright for the overlay smoke test, pino, better-sqlite3 13.
- Pinned versions live in the root package.json. Do not upgrade majors without being asked.
- Tool configs use positive include lists (the workspace globs).
- Windows is the primary dev and runtime OS. Use cross-platform paths and scripts, with no bash-only commands in package.json.
- Your shell is PowerShell:
  - Do not chain with `&&` or `||`, because Windows PowerShell 5.1 lacks them. Use `;` or separate commands.
  - Use `npm.cmd` if execution policy blocks `npm`.
- All files use LF line endings, enforced by `.gitattributes`.

## Twitch rules (do not violate)
- **Realtime path: EventSub WebSocket only** (`wss://eventsub.wss.twitch.tv/ws`). Never IRC, never PubSub.
  - Subscribe within 10 s of `session_welcome`.
  - Handle keepalive, ping/pong and revocation.
  - On `session_reconnect`, keep the old socket open until the new welcome arrives.
- **Helix for all writes:** Send Chat Message, Pinned Chat (`/helix/chat/pins`), Announcements, Chat Settings, Clips, Markers, Polls, Custom Rewards, Blocked Terms. When unsure about a field name or limit, fetch the official reference at https://dev.twitch.tv/docs/api/reference/ instead of guessing.
- **Rate limits.** Every Helix call goes through the token-bucket guard in `apps/server/src/twitch/helix.ts`.
  - At most 60 chat messages per 30 s.
  - At most 1 announcement per 2.5 s.
  - Never send an identical message within 30 s.
- **Auth.**
  - The streamer token comes from the Device Code Grant Flow against one Confidential app.
  - Persist the new refresh token on every refresh.
  - Validate tokens hourly.
  - The app access token is used only for the optional bot account.
- **Scopes:** request only the scopes listed in `apps/server/src/twitch/scopes.ts`. Never add one without being asked.

## OpenAI rules
- **Consensus model:** `gpt-6-luna` via the Responses API.
  - `reasoning.effort: "none"` and `store: false`.
  - Strict `json_schema`: `additionalProperties: false`, all fields required.
  - Inline `moderation: {model: "omni-moderation-latest"}`. Fail closed when a moderation result has `type: "error"`.
  - Prompt order: the static prefix comes first (instructions, persona guide, schema restatement, examples; at least 1,024 tokens), and window data comes last. Use one `prompt_cache_key` per persona.
- **Voice:** `gpt-realtime-2.1-mini` over a server WebSocket (`OpenAIRealtimeWS` from `openai/realtime/ws`).
  - `session.update` with `output_modalities: ["audio"]`, `audio.output.format {type: "audio/pcm", rate: 24000}` and `audio.input.turn_detection: null`.
  - Each line is an out-of-band `response.create {conversation: "none", input: [], instructions: "Say exactly the following, nothing else: <line>"}`.
  - One session per voice. Rotate sessions before 60 minutes.
  - Verify the transcript against the line.
- **Legacy `/v1/audio/speech`** is a fallback adapter only (`VOICE_PROVIDER=legacy`). Never make it the default without updating the README.
- **Cost:** record `usage` from every call into the cost ledger.

## Safety invariants (tests must cover these; never weaken them)
1. Raw chat text is never spoken. Only these are spoken: the verified line, the verified dissent, templated event lines, or an approved Grab-the-mic message.
2. Agreement percent and voice counts are computed in `packages/core/agreement.ts` from author sets. Model-produced numbers are never displayed.
3. The verifier in `packages/core/verify.ts` runs before preview on every line, including templated lines.
4. Preview hold (default 1 s) and veto exist in every mode that speaks. Mute and the kill switch stop audio within 200 ms.
5. Spoken lines never contain usernames, except raid channel names. Lines never contain `@`, URLs or long digit runs.
6. Chat text is treated as data in prompts (datamarked JSON). Instructions inside messages are never followed. Prompt-injection eval cases must stay at 100%.
7. `packages/core` makes no network calls.
8. Offensive test fixtures and the built-in blocklist are stored base64-encoded and decoded at load, never in plain text.

## Commands
- `npm run dev`: server, overlay and control with HMR.
- `npm start`
- `npm run setup`: Device Code Flow.
- `npm test`: unit and replay tests. Must stay under 60 s, because the Stop hook runs it before any turn ends.
- `npm run test:e2e`: Playwright overlay smoke test.
- `npm run typecheck`, `npm run lint`
- `npm run eval`: costs money. Run only when asked.
- `npm run mock -- scenarios/<name>.jsonl`
- `npm run sim -- --authors 300 --rate 60`

## Definition of done for a task
- Code compiles under strict TypeScript and `npm test` passes.
- New behavior has a unit or replay test.
- Logs are structured.
- No secrets in code.
- The README is updated if a setting or endpoint changed.
- Commit messages are in the imperative mood, with a subject of at most 72 characters. They describe what changed and why, in product terms (for example "Add EventSub reconnect handling").

## Do not
- Do not build a Twitch Extension, use IRC, or add other platforms.
- Do not add memory, personality or world knowledge to the consensus prompt.
- Do not write to `.env` or delete files outside the workspace without being asked.
- Do not force-add ignored files, skip git hooks, or change git configuration.
- Do not run `npm run eval` or make any paid API call inside tests.
- Do not change the strict schema or the verifier thresholds without updating the golden set and `eval/README.md`.

## Style
- Small modules with one responsibility.
- Explicit types at boundaries. No default exports.
- Comments explain why, not what.
- Error paths log and degrade (caption-only, templated line, silence) rather than crash.
