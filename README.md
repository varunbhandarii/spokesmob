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

The workspace contains the server, overlay, control page, shared logic, development tools, and evaluation runner. The Twitch listener, automatic beat loop, authenticated controls and overlay audio checks are available.

The [shared beat and overlay contracts](packages/core/README.md) define cycle steps, settings, client roles and message schemas for the loop and control integration.

Run `npm run setup` to sign in to Twitch. Open the activation URL printed by the command, enter its human activation code, and approve the requested permissions. Running setup again reuses valid authorization. The broadcaster account is recommended; moderator authorization is unverified.

Tokens are saved atomically outside the repository: `%LOCALAPPDATA%\Spokesmob\tokens.json` on Windows, or `~/.config/spokesmob/tokens.json` elsewhere. To sign out, stop the application and delete that file (or the file selected by `TOKEN_FILE`). Keep the file private.

After setup, `npm start` listens to Twitch events, serves the overlay locally and runs the beat when the stream is live and an active audio source is connected. One server instance holds a lock beside the token file. It requests chat, chat notices, incoming raids, Hype Train, stream status, poll results and reward redemptions. Reconnects preserve subscriptions when Twitch supplies a handover URL; dropped connections create a fresh session and subscriptions.

Chat collection continues while a beat is being verified or spoken. The next window opens atomically when the previous one closes; underfilled windows keep a rolling 30 s view. The verified line and dissent prepare together during preview, then play in order. Veto, mute, kill or a lost safety condition cancels both takes and prevents output. After the whole spoken unit ends, the loop posts once and pins only a confirmed send, then cools down. Main caption-only, suppressed and vetoed units are not posted. Quiet mode posts after its preview plus 3 s of caption reading without generating voice. Event templates never post a second chat notice.

Settings, mute/kill, gags, beat records and per-call cost reservations use local SQLite beside the token file. Timed mute survives restart until its saved expiry; kill persists until explicit unmute. History cleanup does not reset the active session's spend accounting. Raising the cap can release a capped loop; missing usage keeps its reservation.

EventSub also provides typed message deletions, user-message clears and full chat clears through the existing chat-read authorization. Use `npm run mock -- moderator-actions` to replay these actions locally.

Speech protection combines a built-in profanity matcher, encoded harassment terms and the channel's Twitch blocked terms. Channel terms load at startup and refresh every ten minutes; a failed refresh keeps the last good protection and logs a warning.

Completed polls arrive as `pollEnd` events with the poll title, status and each choice's vote total. They use the existing poll permission requested during setup.

Check authorization with `npm run twitch:check -- --status`, or capture typed events with `npm run twitch:check -- --listen 120`. Wait for "Capture active" before sending plain text, an emote, an @mention and a reply from another account. Output includes subscription timing, fragment types, `self` and `replyToId`.

`npm run twitch:check -- --write` posts one check message, immediately proves local duplicate suppression, pins the confirmed message with a 60-second duration, reads it back, waits about a minute, explicitly unpins it and sends a purple announcement. Keep chat visible while it runs. A failed or uncertain send is never pinned or retried.

Twitch writes use a shared rate limiter. Chat messages and announcements never retry automatically, and identical chat messages are suppressed locally for 30 seconds. Pinning is a separate request after a confirmed send with no drop reason. An empty send result is treated as not sent and is never pinned or retried.

The typed [Get Streams](https://dev.twitch.tv/docs/api/reference/#get-streams) read queries the resolved broadcaster by `user_id` through the general-rate guard, without extra permissions. Empty results and entries without `type: "live"` do not establish online status; malformed or mismatched responses fail closed. The mock supports live/offline state with the same response contract.

## Commands and local API

Run `npm run build` before starting the server. Copy the dock URL with `npm run voice -- --copy-url control`, then paste it into OBS **Docks → Custom Browser Docks**. Keep its token private. The [control dock guide](apps/control/README.md) covers its layout, shortcuts, resync and log export. The same page works in a browser.

The dock shows step and blocking conditions, mode, question, health, cost, latency and beat history. Veto cancels either take; Mute and Kill stop both. Focus the dock to use V, S, M, K and U for Veto, Speak now, Mute, Kill and Unmute. Editing a field suppresses shortcuts. **Test while offline** is a visible, session-only exception to the live-stream gate and resets at restart.

The layout selector changes the shared overlay layout. A valid explicit `layout` query parameter pins that browser source instead. Ordinary control tabs never claim audio ownership.

Only the broadcaster badge or moderator badge authorizes chat commands, including the broadcaster's own messages. Other accounts are ignored silently. Commands never count as votes.

| Command | Action |
| --- | --- |
| `!mob on` / `!mob off` | Resume or pause beats; off does not post a muted message |
| `!mob mode auto\|demand\|quiet` | Change the saved mode |
| `!mob speak` / `!mob veto` | Close an On-demand window or cancel the current spoken unit |
| `!mob mute [minutes]` | Mute for 1?60 minutes, defaulting to 5 |
| `!mob unmute` / `!mob kill` | Clear a mute or kill until explicit unmute |
| `!mob gag @user` / `!mob ungag @user` | Exclude or restore a user resolved from Twitch's mention fragment |
| `!ask <question>` / `!mob clear` | Set a moderated question of at most 100 characters, or clear it |

State changes acknowledge once through the chat guard. Gag acknowledgments never repeat the name. Questions reject URLs and mentions, pass the blocklist and per-item moderation, then announce in purple. Clear cancels a pending question change too.

HTTP controls use the same handlers: `POST /api/on`, `off`, `speak`, `veto`, `mute`, `unmute`, `kill`, `mode`, `question`, `clear` and `settings`. Bodies are strict JSON: empty `{}` for simple actions, `{"minutes":5}`, `{"mode":"demand"}`, `{"question":"Name my cat"}` or `{"changes":{"holdMs":1000}}`. Send the local token through `Authorization: Bearer <token>` or the token query parameter; never publish a credential-bearing URL. POST requires the local Origin, and all requests require the local Host. Foreign origins are rejected.

`GET /api/state` returns `{state,settings}`. `GET /api/log?limit=200` returns newest-first records with cited names omitted. Add `names=1` to include them, and `before=<last-row-id>` for the next page. Request and error logs omit URLs and credentials.

WebSocket clients declare one immutable role in hello. Only control clients may send commands or voice checks. They receive state, health, cost and log updates with no audio. Overlays receive visuals and verified audio, with playback reports accepted only from the current audio owner.

## Local Twitch mock

`npm run loop -- --mock name-my-cat` starts the complete local loop, including mock Twitch authorization, EventSub and Helix. It shares the local overlay token and port with the normal server, so stop that server first. Mock Twitch credentials stay synthetic and never replace your saved Twitch token. Settings and history use a separate `mock-spokesmob.db` beside the token file.

Open the OBS overlay and the control dock to release the audio-client gate. By default the consensus model is a stub and voice playback is simulated without PCM. Log rows say **Simulated**; their timing does not measure a model or real audio. The terminal shows mock send and pin requests without message content. Veto, mute, kill and all other gates still run.

Add `--minutes 3 --report` for a finite run with outcome counts, window-processing p50/p95/max, latency stages, heap samples and cost. Stages overlap: voice preparation runs during the preview hold, so stage percentiles must not be added. `--headless` supplies a simulated client only when both providers are stubs; paid flags reject it. `--port 0` selects a temporary port for unattended local checks.

`npm run loop -- --mock crowd --authors 300 --rate 60 --minutes 5 --report` runs the full load check outside the unit-test suite. A five-minute crowd uses 18,000 synthetic messages. Window-processing measurements include assembly and clustering during premoderation and synthesis; listening-only assembly is reported separately. Every begun beat must resolve or remain explicitly pending, and cancelled or suppressed outcomes are counted separately from dropped beats. Heap samples include garbage-collection variation.

`--live-model` and `--live-voice` opt into paid OpenAI calls while Twitch stays mocked. Approve the displayed projection before adding `--yes`; `--max-cost-usd` sets a fixed run ceiling (default USD 0.10) that panel settings cannot raise. All paid calls retain reservations and unknown usage. A real API failure stops the mock run and reports it. Real end-to-end timing requires `--live-voice` and the active OBS audio owner's playback report. The default mock is free.

`npm run mock -- name-my-cat` starts a local EventSub, Helix and authorization server. Other scenarios include `raid-arrival`, `hype-train`, `reconnect-midstream`, `keepalive-silence`, `revocation`, `notices` and `poll-and-redemption`. Use `--speed 5` (up to 20), `--loop`, or `--port 8081` as needed. A JSONL file path also works.

Archived replay leaves the file untouched. The mock skips recorded session controls, adapts subscription and session IDs, and rebases envelope timestamps while preserving event spacing at the selected speed. Event content and first-pass message IDs stay unchanged; later loops get unique envelope IDs. Use `--literal-timestamps` to preserve archived timestamps and exercise stale-frame rejection.

Use the three URL overrides printed by the mock, client ID `mock-client`, any synthetic client secret and channel `spokesmob_demo`. Select a separate token file with `TOKEN_FILE` and run setup against those overrides. Mock authorization completes automatically; never send real credentials to the mock. Clear the overrides before reconnecting to Twitch.

Generate a larger synthetic conversation with `npm run sim -- --authors 300 --rate 60 --seconds 60 --clusters "gary:0.4,pickles:0.2,noise:0.4" --out crowd.jsonl`, then replay it with `npm run mock -- crowd.jsonl --speed 20`. `--seed` makes output reproducible; `--repeat-share`, `--typo-share`, `--case-share` and `--emote-share` control variation.

For labeled conversations, give each cluster its own phrases: `--clusters "gary=gary|name him gary:0.5,cat=猫|gato:0.5"`. `--spec <file.json>` loads the same generator settings from JSON; explicit command options override the file. Generated chat rows carry a ground-truth label for offline quality checks, which the mock omits from Twitch payloads.

## How a line is chosen

Messages are normalized into text and emote signals. Self messages, commands and excluded or moderator-deleted messages do not count. Repeated messages from one person never create extra votes. Emote-only participants still count toward the window's voice total and mood.

Similar messages form clusters, with negations kept apart. The server moderates each selected exemplar separately while the window fills, caches those results, removes flagged buckets and rebuilds the counts. Severe flags or unavailable moderation suppress the window. Channel blocked terms add to the built-in blocklist.

OpenAI receives the active question, voice total, mood signals and up to twelve clusters containing author counts, shares and short exemplars. It receives no author names or IDs. Chat strings remain untrusted data inside a marked JSON envelope. The model proposes a short line, citations and optional dissent; the application computes agreement from the cited author sets.

The immediately previous verified line is supplied as the mob's own prior output to avoid repeated phrasing. It supplies no votes or evidence for the new window. The near-duplicate verifier and single regeneration attempt still apply.

Each model response also includes an alternate wording with the same citations. When the main line fails only for repeating the previous line, the alternate passes the full verifier before selection. The selected text is used for captions, voice and the chat post. Both candidates share the existing inline output-moderation result; no additional moderation call is needed. Beat records retain rejected candidate text and failure codes, encoding blocked text.

When every cluster has a share below 0.20, the prompt can name up to three cited options using source wording. When at least two clusters each have a share of 0.25 or more, it cites only the largest one, breaking ties either way, and puts the next-largest one in dissent. It never adds opposing sides together as the main agreement in that case.

The verifier checks support, wording, length, blocked terms, contact patterns, usernames and output moderation before a line is accepted. A rejected generation can be rewritten once. A transport failure or two rejected generations can use a separately moderated, verified fallback; otherwise the window is suppressed with a reason. Consensus commands print results without speaking or posting them.

Fast is the selected model tier. In a paired local comparison, model-call p95 was 1.639 s on fast versus 6.007 s on default, with zero versus eight timeouts. After the share-rule prompt fix, the full fast evaluation passed all 100 quality and latency checks; p95 was 1.217 s and mean model cost was about USD 0.000114 per call. These are recorded measurements, not fixed response-time guarantees.

## Configuration

`npm run consensus -- name-my-cat` checks recorded scenario input locally. A JSONL path or a golden JSON file also works; `--window 8` sets scenario window length and `--question "Name the cat?"` supplies context. Offline output is unmoderated, uses a deterministic stub and is not for streaming.

`--live` uses the OpenAI consensus pipeline and costs money. Run it manually after reviewing the expected call count. It prints verified lines or suppression reasons, author-counted percentages, dissent, mood, per-stage latency and available cost. `--tier fast` overrides the configured tier. Nothing is spoken or posted. `npm run consensus -- --count-prefix` uses the API token counter and prints the static prefix token count and SHA-256; run it only as an approved API check.

`npm run eval -- --offline` checks the evaluation harness without API calls. For a paid run, first review `npm run eval -- --plan` and approve its projected cost and call count. The [evaluation guide](eval/README.md) describes the reviewed golden windows, assertions, reports and separate tier comparison.

`npm run eval -- --compare-tiers --n 5 --max-cost-usd 0.10 --plan` projects a paired default/fast evaluation of all windows. Remove `--plan` only after approval within the displayed cost limit. Comparison samples alternate default then fast with one worker. Reports separate quality from latency and show each tier's p50/p95/max, timeouts and available cost; `--baseline eval/reports/<report>.json` checks category quality against an earlier completed run.

The conservative preflight is the default. Use `--preflight expected` only with explicit approval to admit a run using its expected cached-cost projection; the selected runtime limit and conservative per-request reservations still apply.

Copy `.env.example` to `.env` and fill in your credentials locally. Keep credentials out of source control.

| Variable | Purpose |
| --- | --- |
| `TWITCH_CLIENT_ID` | Twitch application client ID |
| `TWITCH_CLIENT_SECRET` | Twitch application client secret |
| `TWITCH_CHANNEL` | Broadcaster login, in lowercase |
| `TWITCH_BOT_LOGIN` | Optional separate bot login |
| `OPENAI_API_KEY` | OpenAI project API key; required for the automatic loop and commands that call OpenAI |
| `CONSENSUS_SERVICE_TIER` | `fast` (selected default); `default` is available as an explicit override |
| `MIN_VOICES` | Minimum distinct authors for a line; integer from 1 to 10, defaults to `2` |
| `BEAT_MODE` | Initial mode: `auto`, `demand` or `quiet`; defaults to `auto` |
| `WINDOW_S` | Initial collection window, `5`–`20` seconds; defaults to `8`, adapts up to `30` |
| `HOLD_MS` | Preview hold, `500`–`3000` milliseconds; defaults to `1000` |
| `COOLDOWN_S` | Delay after the spoken unit and output settle, `0`–`10` seconds; defaults to `2` |
| `PIN_S` | Confirmed-post pin duration, `30`–`1800` seconds; defaults to `60` |
| `POST_LINES` | `every` (default) or `off`; saved control settings override these environment seeds |
| `MUTE_DEFAULT_MIN` | Default timed mute, `1`–`60` minutes; defaults to `5` |
| `VOICE_PROVIDER` | `realtime`; legacy is unavailable in this version |
| `MAIN_VOICE` | Main voice; defaults to `cedar` |
| `WHISPER_VOICE` | Dissent voice; defaults to `sage` |
| `OPENAI_REALTIME_URL` | Development and tests only: loopback mock WebSocket; leave unset for OpenAI |
| `PORT` | Local HTTP port; defaults to `4040` |
| `EVENTSUB_URL` | EventSub WebSocket URL; override for local development |
| `HELIX_URL` | Development or testing only, leave unset; defaults to Twitch Helix |
| `TWITCH_AUTH_URL` | Development or testing only, leave unset; defaults to Twitch OAuth |
| `TOKEN_FILE` | Development or testing only, leave unset; overrides the local token file |
| `RECORDINGS_DIR` | Local chat recording folder; defaults beside the token file; keep it outside the repository |
| `DB_FILE` | SQLite settings, gags, beat history and cost ledger; defaults to `spokesmob.db` beside the token file, outside the repository |
| `LOG_RETENTION_DAYS` | Beat and cost history retention, from `0` to `30` days; defaults to `7`; cleanup runs at startup and hourly |
| `SPEND_CAP_USD` | Per-stream spend cap; defaults to `5` USD |
| `LOG_LEVEL` | Structured log verbosity; defaults to `info` |

## OBS audio setup

Run `npm run build`, then `npm start` and leave the server running. Startup saves the complete overlay URL beside the local token file and prints only its file path. In another terminal, run `npm run voice -- --copy-url` to copy the URL without displaying its token.

In OBS 33, add exactly one Spokesmob Browser source. Paste the copied URL, use 1920 × 1080, and enable **Control audio via OBS**. Turn off **Shutdown source when not visible** and **Refresh browser when scene becomes active**. Remove leftover Spokesmob browser sources: a hidden source keeps running and can take over audio.

In **Advanced Audio Properties**, check Audio Monitoring **Enable**, keep the source unmuted and select your recording track. In **Settings → Audio → Advanced**, select your headphones as the monitoring device. Disable or mute **Desktop Audio** when it captures that same output; otherwise OBS records both the source and its monitored copy, producing doubled sound or an echo.

Start a short recording and run `npm run voice -- --tone`. It generates a free one-second beep through the same take, socket and audio-player path. Confirm the headphones, source meter and recording each have one clean beep. A regular Chrome tab with the same URL shows **preview, silent** and produces no audio. Audio is enabled only in OBS or with an explicit `audio=1` URL setting; keep just one audio-playing client.

After a server restart, the overlay and control panel reconnect automatically with a retry delay capped at five seconds. Keep the browser source active while it reconnects.

Before enabling the beat, startup retrieves model metadata over the HTTP connection and connects/configures both voice sessions. This warm-up submits no prompt, audio input or response-generation request and consumes no model tokens. A failed warm-up logs a warning and leaves the server and controls running; the first beat can connect on demand. The first actual generation still performs model and prompt-cache work. Free mock runs keep using stubs.

Spokesmob uses an **AI-generated voice**. Disclose that to viewers. Dissent is a different voice spoken normally, made softer by the overlay mixer; the model is never prompted to whisper. Generation is held on the server until transcript and raw-audio checks pass, then edge silence is trimmed before playback. A failed retry becomes caption-only; legacy is unavailable and is never called automatically.

`npm run voice -- --say "A lot of chat says pink, red or orange." --yes`, `--kill-test --yes`, and `--calibrate 40 --yes` make paid calls and require approval of their projection. Calibration defaults to verified synthetic lines, reports metrics and rejected transcripts locally, and saves no audio. Calibration reserves a capped attempt's estimated cost before dispatch; `--max-cost-usd` sets its runtime budget, defaulting to USD 0.10. Missing usage keeps that reservation and an unknown cost. Its usable-audio gates run on untrimmed PCM; overlay gain and filters cannot change acceptance. Numeric thresholds are changed only after reviewing new validated evidence.

To check dissent, run `npm run voice -- --say "Some of chat still says blue." --dissent --yes`. Record the main line, kill test and dissent in OBS: speech should play once, the kill test should stop within 200 ms, and dissent should be softer but intelligible. CLI results include verified-ready time, playback start, trim metrics and the kill test's `silenceMs`.

In a 40-line calibration, all lines verified with one discarded transcript mismatch and retry, no usable-audio rejection and mean cost USD 0.000985 per line. First audio was p50/p95 336/481 ms, complete generation 491/689 ms, and verified-ready 496/767 ms. A separate live check after restart had first audio at 927 ms, verified-ready at 1,189 ms and playback at 1,295 ms; a subsequent line reached first audio at 428 ms. The audible kill check stopped in 1 ms according to the overlay report. These are observed timings; check the first line after restart during rehearsal.

## Local recordings

`npm run record -- --minutes 2` records raw Twitch frames. `--out <file>` selects a new output file. Recordings stay local; startup lists and deletes JSONL recordings older than seven days from the configured recording folder. Source folders that are public in Git cannot hold raw recordings.

Use `npm run record -- --anonymize <input> <output> --replace-text` to create a fixture with deterministic fake identities and synthetic chat text. Without `--replace-text`, message text remains and requires each author's consent before publication. Anonymization removes reply bodies, colors and emote owner IDs. Output files must be new; existing files are not overwritten.

Public badge categories and emote identifiers are preserved so replay retains their meaning.
