# Spokesmob

Your chat, one voice.

Spokesmob turns Twitch chat into one spoken voice with visible agreement and an OBS browser-source overlay.

## Development

Requires Node.js 24.15 or newer and npm. Storage uses Node's built-in SQLite.

```powershell
npm install
npm run typecheck
npm test
npm run lint
```

The workspace contains the server, overlay, control page, shared logic, development tools, and evaluation runner. Startup commands are still under development.

Run `npm run setup` to sign in to Twitch. Open the activation URL printed by the command, enter its human activation code, and approve the requested permissions. Running setup again reuses valid authorization. The broadcaster account is recommended; moderator authorization is unverified.

Tokens are saved atomically outside the repository: `%LOCALAPPDATA%\Spokesmob\tokens.json` on Windows, or `~/.config/spokesmob/tokens.json` elsewhere. To sign out, stop the application and delete that file (or the file selected by `TOKEN_FILE`). Keep the file private.

After setup, `npm start` listens to Twitch events. One server instance holds a lock beside the token file. It requests chat, chat notices, incoming raids, Hype Train, stream status, poll results and reward redemptions. Reconnects preserve subscriptions when Twitch supplies a handover URL; dropped connections create a fresh session and subscriptions. The overlay, control page and speaking loop are still under development.

EventSub also provides typed message deletions, user-message clears and full chat clears through the existing chat-read authorization. Use `npm run mock -- moderator-actions` to replay these actions locally.

Speech protection combines a built-in profanity matcher, encoded harassment terms and the channel's Twitch blocked terms. Channel terms load at startup and refresh every ten minutes; a failed refresh keeps the last good protection and logs a warning.

Completed polls arrive as `pollEnd` events with the poll title, status and each choice's vote total. They use the existing poll permission requested during setup.

Check authorization with `npm run twitch:check -- --status`, or capture typed events with `npm run twitch:check -- --listen 120`. Wait for "Capture active" before sending plain text, an emote, an @mention and a reply from another account. Output includes subscription timing, fragment types, `self` and `replyToId`.

`npm run twitch:check -- --write` posts one check message, immediately proves local duplicate suppression, pins the confirmed message with a 60-second duration, reads it back, waits about a minute, explicitly unpins it and sends a purple announcement. Keep chat visible while it runs. A failed or uncertain send is never pinned or retried.

Twitch writes use a shared rate limiter. Chat messages and announcements never retry automatically, and identical chat messages are suppressed locally for 30 seconds. Pinning is a separate request after a confirmed send with no drop reason. An empty send result is treated as not sent and is never pinned or retried.

## Local Twitch mock

`npm run mock -- name-my-cat` starts a local EventSub, Helix and authorization server. Other scenarios include `raid-arrival`, `hype-train`, `reconnect-midstream`, `keepalive-silence`, `revocation`, `notices` and `poll-and-redemption`. Use `--speed 5` (up to 20), `--loop`, or `--port 8081` as needed. A JSONL file path also works.

Archived replay leaves the file untouched. The mock skips recorded session controls, adapts subscription and session IDs, and rebases envelope timestamps while preserving event spacing at the selected speed. Event content and first-pass message IDs stay unchanged; later loops get unique envelope IDs. Use `--literal-timestamps` to preserve archived timestamps and exercise stale-frame rejection.

Use the three URL overrides printed by the mock, client ID `mock-client`, any synthetic client secret and channel `spokesmob_demo`. Select a separate token file with `TOKEN_FILE` and run setup against those overrides. Mock authorization completes automatically; never send real credentials to the mock. Clear the overrides before reconnecting to Twitch.

Generate a larger synthetic conversation with `npm run sim -- --authors 300 --rate 60 --seconds 60 --clusters "gary:0.4,pickles:0.2,noise:0.4" --out crowd.jsonl`, then replay it with `npm run mock -- crowd.jsonl --speed 20`. `--seed` makes output reproducible; `--repeat-share`, `--typo-share`, `--case-share` and `--emote-share` control variation.

For labeled conversations, give each cluster its own phrases: `--clusters "gary=gary|name him gary:0.5,cat=猫|gato:0.5"`. `--spec <file.json>` loads the same generator settings from JSON; explicit command options override the file. Generated chat rows carry a ground-truth label for offline quality checks, which the mock omits from Twitch payloads.

## Configuration

`npm run consensus -- name-my-cat` checks recorded scenario input locally. A JSONL path or a golden JSON file also works; `--window 8` sets scenario window length and `--question "Name the cat?"` supplies context. Offline output is unmoderated, uses a deterministic stub and is not for streaming.

`--live` uses the OpenAI consensus pipeline and costs money. Run it manually after reviewing the expected call count. It prints verified lines or suppression reasons, author-counted percentages, dissent, mood, per-stage latency and available cost. `--tier fast` overrides the configured tier. Nothing is spoken or posted. `npm run consensus -- --count-prefix` uses the API token counter and prints the static prefix token count and SHA-256; run it only as an approved API check.

`npm run eval -- --offline` checks the evaluation harness without API calls. For a paid run, first review `npm run eval -- --plan` and approve its projected cost and call count. The [evaluation guide](eval/README.md) describes the reviewed golden windows, assertions, reports and separate tier comparison.

`npm run eval -- --compare-tiers --n 5 --max-cost-usd 0.10 --plan` projects a paired default/fast evaluation of all windows. Remove `--plan` only after approval within the displayed cost limit. Comparison samples alternate default then fast with one worker. Reports separate quality from latency and show each tier's p50/p95/max, timeouts and available cost; `--baseline eval/reports/<report>.json` checks category quality against an earlier completed run.

Copy `.env.example` to `.env` and fill in your credentials locally. Keep credentials out of source control.

| Variable | Purpose |
| --- | --- |
| `TWITCH_CLIENT_ID` | Twitch application client ID |
| `TWITCH_CLIENT_SECRET` | Twitch application client secret |
| `TWITCH_CHANNEL` | Broadcaster login, in lowercase |
| `TWITCH_BOT_LOGIN` | Optional separate bot login |
| `OPENAI_API_KEY` | OpenAI project API key; required only for commands that call OpenAI |
| `CONSENSUS_SERVICE_TIER` | `default` (initial setting) or `fast`; select after measuring latency and cost |
| `MIN_VOICES` | Minimum distinct authors for a line; integer from 1 to 10, defaults to `2` |
| `VOICE_PROVIDER` | `realtime` (default) or `legacy` |
| `MAIN_VOICE` | Main voice; defaults to `cedar` |
| `WHISPER_VOICE` | Dissent voice; defaults to `sage` |
| `PORT` | Local HTTP port; defaults to `4040` |
| `EVENTSUB_URL` | EventSub WebSocket URL; override for local development |
| `HELIX_URL` | Development or testing only, leave unset; defaults to Twitch Helix |
| `TWITCH_AUTH_URL` | Development or testing only, leave unset; defaults to Twitch OAuth |
| `TOKEN_FILE` | Development or testing only, leave unset; overrides the local token file |
| `RECORDINGS_DIR` | Local chat recording folder; defaults beside the token file; keep it outside the repository |
| `SPEND_CAP_USD` | Per-stream spend cap; defaults to `5` USD |
| `LOG_LEVEL` | Structured log verbosity; defaults to `info` |

OBS connection instructions will be added as the application becomes available.

## Local recordings

`npm run record -- --minutes 2` records raw Twitch frames. `--out <file>` selects a new output file. Recordings stay local; startup lists and deletes JSONL recordings older than seven days from the configured recording folder. Source folders that are public in Git cannot hold raw recordings.

Use `npm run record -- --anonymize <input> <output> --replace-text` to create a fixture with deterministic fake identities and synthetic chat text. Without `--replace-text`, message text remains and requires each author's consent before publication. Anonymization removes reply bodies, colors and emote owner IDs. Output files must be new; existing files are not overwritten.

Public badge categories and emote identifiers are preserved so replay retains their meaning.
