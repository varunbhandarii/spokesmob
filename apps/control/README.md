# Control dock

Build with `npm run build --workspace apps/control`. The local server serves the built app at `/control/`. Copy its private URL with `npm run voice -- --copy-url control` and paste it into OBS **Docks → Custom Browser Docks**. A normal browser window works too. The page fits a dock about 350 px wide and expands into two columns in a wider window.

The dock never requests or plays audio. Its WebSocket hello declares `role: "control"`; it receives the beat view, health, cost and log messages through the [shared contract](../../packages/core/README.md). It sends validated commands to the server's common command handlers. Reconnect delays cap at five seconds. Settings and recent logs resync through authenticated `/api/state` and `/api/log` requests after reconnect. Unsaved form edits remain intact.

V, S, M, K and U activate Veto, Speak now, Mute 5 min, Kill and Unmute while the dock is focused. Shortcuts ignore text fields, modified keys and key repeats. Veto remains available throughout Speaking, including dissent. Kill requires no confirmation. **Test while offline** is a deliberate session-only switch with a visible warning; it resets at server restart.

The **Captions only** mode runs without voice. Its command and API value is `quiet`; Mute and Kill remain separate controls that stop and hold the beat.

The layout selector changes `state.layout`. An overlay source with an explicit valid `layout` query parameter keeps its pinned layout; other overlay sources follow the state. The test-tone button uses the free server-generated tone.

The view shows the newest 200 beats. **Copy beat** fetches the complete selected row with cited names. **Export log** walks retained history using `/api/log?limit=200&names=1&before=<last-row-id>` and downloads JSON only after all pages succeed. A repeated cursor, duplicate row or browser memory bound stops the export with a visible error; no partial file is labeled complete. The API token is sent in the Authorization header and never rendered or logged.

During preview, a card above Live controls shows the verified main line, optional dissent, agreement count and a countdown for the configured hold. Captions-only previews carry a labeled chip. Its large red Veto uses the same command path as V and the regular Veto button. The card hides as soon as the beat leaves preview or the connection is lost. A confirmed veto replaces the content with "Vetoed" for two seconds; a new preview takes priority. All incoming text is rendered as text, never HTML.


Preview counts include the unit ("71% of 312 voices"). Dissent includes its separate author-counted share ("18% · Some prefer Milo."). Both percentages come from core; the control-only preview message carries the existing computed dissentPct.
