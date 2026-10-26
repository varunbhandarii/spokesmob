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

The workspace contains the server, overlay, control page, shared logic, development tools, and evaluation runner. Application commands currently print `not implemented`.

## Configuration

Copy `.env.example` to `.env` and fill in your credentials locally. Keep credentials out of source control.

| Variable | Purpose |
| --- | --- |
| `TWITCH_CLIENT_ID` | Twitch application client ID |
| `TWITCH_CLIENT_SECRET` | Twitch application client secret |
| `TWITCH_CHANNEL` | Broadcaster login, in lowercase |
| `TWITCH_BOT_LOGIN` | Optional separate bot login |
| `OPENAI_API_KEY` | OpenAI project API key |
| `VOICE_PROVIDER` | `realtime` (default) or `legacy` |
| `MAIN_VOICE` | Main voice; defaults to `cedar` |
| `WHISPER_VOICE` | Dissent voice; defaults to `sage` |
| `PORT` | Local HTTP port; defaults to `4040` |
| `EVENTSUB_URL` | EventSub WebSocket URL; override for local development |
| `SPEND_CAP_USD` | Per-stream spend cap; defaults to `5` USD |
| `LOG_LEVEL` | Structured log verbosity; defaults to `info` |

Setup, startup, and OBS connection instructions will be added as the application becomes available.
