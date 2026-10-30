# Original face task for Codex cloud

Run three independent attempts from the same reviewed commit. Use the common prompt below and one different art direction per attempt. Keep attempts on separate branches for comparison; do not merge.

## Art directions

1. **Round Ink:** soft asymmetrical ink silhouette, broad readable eyes, deliberate linework; sage, cream and deep ink.
2. **Folded Paper:** hand-cut angular silhouette, layered paper-like planes, expressive lids and brows; warm cream, restrained coral and charcoal.
3. **Soft Geometry:** elastic pebble-like silhouette, offset geometric features and a distinct original profile; cool teal, pale gold and deep blue.

## Common prompt

Read AGENTS.md first. Replace the temporary circular face with one polished, original SVG face for Spokesmob, a Twitch chat consensus voice. Use the art direction supplied with this task. Make it expressive and legible at 180 px and 600 px, with a memorable silhouette and readable moods.

Read before editing:
- apps/overlay/src/face/types.ts
- apps/overlay/src/face/index.ts and face/face.css
- apps/overlay/src/view/render.ts and view/loop.ts
- apps/overlay/src/face-sheet.ts
- apps/overlay/README.md

Edit only apps/overlay/src/face/**. Keep types.ts and its interface unchanged. Keep the named createFace({seed,size}) export in face/index.ts. Local helper/CSS files may be added inside face/. Do not change the renderer, audio, protocol, scenes, layout, tests, scripts or dependencies.

Implement every FaceRig method: element, setPose, setMood, setHype, setMouth, lookAt, update and destroy. The SVG viewBox is exactly 0 0 512 512. Support all nine FacePose values and all five MouthShape values in types.ts. Pose transitions settle over 150-250 ms. update(nowMs) comes from the existing external frame loop; create no timers or requestAnimationFrame loop. Use seeded randomness for blinks and idle motion, never Math.random or clock reads. destroy removes the rig without leaving listeners or scheduled work.

Keep mouth shapes independently controllable each frame. Muted has a zipped mouth; asleep has closed lids; aside reads as a softer second voice. Make thinking, inhale, reading and settle visibly distinct. Mood changes brows, lids, cheek blush and tint through CSS variables. Hype adds a restrained gold treatment. Eyes follow lookAt coordinates in -1..1. Animate only transform and opacity. Avoid flashing; no effect may exceed three flashes per second.

Build the art directly as SVG code. No third-party assets, images, fonts, dependencies or remote requests. No text or lettering in the art and no resemblance to existing mascots, logos or emotes. Construct SVG with DOM APIs, never innerHTML. Keep the strict Content-Security-Policy: bundled CSS, no inline style blocks, scripts or unsafe URL content.

Validate with npm run typecheck, npm test, npm run lint and npm run test:e2e. The last command builds the apps and captures every layout/state and the complete face sheet through the synthetic harness; no API keys or paid calls are needed. If Chromium is absent, install it with npx playwright install chromium. Inspect the face-sheet image for every mood/mouth pair and pose, and all three layout images. Fix clipping, indistinguishable poses and unreadable small-size features within face/ only. Never commit screenshots, test-results or generated output.

Return the art direction, changed files, validation results and branch/commit for comparison. Do not push or merge without instruction.

Reference: [official OpenAI guidance for clear coding tasks](https://learn.chatgpt.com/docs/prompting): specify behavior, files, constraints and verification.
