# Overlay renderer harness

The live overlay keeps the verified-audio player. Messages enter a view store; the renderer has one animation-frame loop and an injected clock. Source inactivity pauses the loop and clears displayed text. Visual randomness uses a passed seed.

Run `npm run test:e2e` from the repository root. It builds both browser apps, starts a synthetic local HTTP harness, runs Chromium and saves screenshots under ignored `test-results/`. Install the pinned browser once with `npx playwright install chromium`. Tests never connect to Twitch or OpenAI and are separate from `npm test`.

- `index.html`: live overlay with audio and OBS source-activity wiring.
- `scene.html?scene=speaking&layout=wide`: scripted synthetic messages and playback reports without a WebSocket or audio generation. Scenes are listed in `src/view/scenes.ts`.
- `face-sheet.html`: seven mood states including neutral crossed with five mouth shapes, plus all nine poses.

The circular face is temporary. Captions use bundled Atkinson Hyperlegible Next variable 5.2.6, fitted plates and at most three lines. Word highlighting follows the advertised duration and local played-sample reports. Text appears only at main playback start or a matching reveal, lingers for the greater of 2.5 seconds and 55 ms per character, and clears immediately on cancellation or lost safety gates. The stage QR uses uqr@0.1.2 to encode the hello channel's exact HTTPS Twitch URL with error correction M, four-module quiet zone and black modules on white. The selected-face audio envelope remains a separate layer.

## Message additions

| Direction     | Message / field                                      | Meaning                                                                           |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Controls only | `preview{take,text,dissent,pct,voices,holdMs,quiet}` | Verified text at preview entry; overlays reject it.                               |
| Overlay       | `reveal{take}`                                       | Show a matching verified caption after the server hold, without audio playback.   |
| Overlay hello | `channel`                                            | Validated channel login, used by the stage layout.                                |
| Overlay line  | `dissentPct`                                         | Integer or null; core computes distinct dissent authors divided by window voices. |

Voice captions become visible on the player's `started` report. `line`, `prepare` and `play` alone never show text. Captions-only reveals its original preview ID after the hold. Failed main voice keeps normal audio cancellation, then sends a new line and one reveal with a fresh ID from the same increasing take counter. Its vetoable reading interval is `max(2500 ms, 55 ms * characters)`; it clears when the server finishes reading and never posts. Veto before fallback produces neither a new line nor reveal.

Stop-all applies to IDs already known when received. A fresh later ID can appear only through a new line plus started/reveal. Stopped IDs and stale events cannot resurrect text. Mute, Kill, off, lost gates, inactivity and disconnect clear the view. Reload starts from hello without replaying old text.

## State to visual

| Input                                        | Pose                | Caption                                        |
| -------------------------------------------- | ------------------- | ---------------------------------------------- |
| Listening                                    | idle                | No new text                                    |
| Synthesizing                                 | thinking            | No new text                                    |
| Preview                                      | inhale              | Hidden                                         |
| Main started                                 | speaking            | Main becomes visible                           |
| Dissent started                              | aside               | Dissent becomes visible                        |
| Ended / cooldown                             | settle              | Main may remain until the text layer clears it |
| Reveal                                       | reading             | Matching verified line becomes visible         |
| Veto / stop                                  | idle within 200 ms  | Cleared; late events ignored                   |
| Muted / killed                               | muted, zipped mouth | Cleared; Muted tag                             |
| Off / offline / capped / no audio / inactive | asleep              | Cleared                                        |

Muted/killed wins over sleep conditions. Inactivity cancels animation-frame work. A valid layout query pins that source; otherwise it follows state.layout.

## Starting zones

Coordinates use a transparent 1920 x 1080 stage; values live in `src/view/layout.ts`.

| Layout  | Face              | Caption                                                              | Other zones                                                                                                          |
| ------- | ----------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| wide    | 300 px at 48,712  | x380..1540; main 48 px, dissent 30 px; stack ends 56 px above bottom | Margin 48; right meter; counter 28 px below face; centered question 40 px; badge 18 px; particles x0..900/y600..1080 |
| stage   | 600 px at 660,150 | 1500 px wide at x210; main 72 px, dissent 44 px                      | Margin 64; meter 56 px; counter 120 px below header; question y64/font64; QR280 right; full-screen particles         |
| compact | 180 px at 40,870  | x250..1600 at 36 px                                                  | Margin32; bottom bar; right meter/counter; bar-only particles                                                        |

Screenshots are layout probes and are never committed. Reload the OBS source once after rebuilding to load a changed renderer.

The agreement tag reads "71% of 312 voices"; dissent reads "18% · Some prefer Milo." after dissent playback starts. Stage labels its large counter and invites viewers to type; smaller chats get the same invitation in the other layouts. Preview shows an ellipsis bubble without line text. Unrelated speech retains the question header and adds "Meanwhile, chat says". Raid banners last six seconds, while the Hype Train chip follows persistent state. The AI voice badge sits at the face's upper right. Temporary-face and synthetic-scene labels belong only to the harness pages; the production entry never renders them.

Name particles use Canvas 2D and a preallocated 400-entry pool. A bounded 512-entry bitmap cache renders names with canvas text APIs; visible labels are at most 24 Unicode characters. Seeded drift stays within the selected layout band. Main playback start gathers matching cited full names into the mouth. A clear message wipes the canvas and pending name batches, including while the source is inactive. The particle layer shares the existing animation-frame loop.
