import { MOODS } from "../../../packages/core/src/types.js";
import { createFace } from "./face/index.js";
import type { FacePose, MouthShape } from "./face/types.js";
import "./view/view.css";

const rigs: ReturnType<typeof createFace>[] = [];
const mouths: MouthShape[] = ["closed", "mid", "open", "wide", "o"];
const poses: FacePose[] = [
  "idle",
  "thinking",
  "inhale",
  "speaking",
  "aside",
  "settle",
  "reading",
  "muted",
  "asleep",
];
function cell(
  parent: Element,
  label: string,
  pose: FacePose,
  mouth: MouthShape,
  mood: (typeof MOODS)[number] | null,
  index: number,
) {
  const host = document.createElement("div");
  host.className = "face-cell";
  const rig = createFace({ seed: 1729 + index, size: 188 });
  rig.setMood(mood);
  rig.setPose(pose);
  rig.setMouth(mouth === "closed" ? 0 : 0.8, mouth);
  rig.update(250);
  rigs.push(rig);
  const text = document.createElement("p");
  text.textContent = label;
  host.append(rig.element, text);
  parent.append(host);
}
const moodGrid = document.querySelector("#mood-grid");
const poseGrid = document.querySelector("#pose-grid");
if (!moodGrid || !poseGrid) throw new Error("Face sheet unavailable");
let index = 0;
for (const mood of [null, ...MOODS])
  for (const mouth of mouths)
    cell(moodGrid, `${mood ?? "neutral"} / ${mouth}`, "idle", mouth, mood, index++);
for (const pose of poses)
  cell(poseGrid, pose, pose, pose === "speaking" ? "open" : "closed", null, index++);
document.body.dataset.ready = "true";
window.addEventListener("pagehide", () => {
  for (const rig of rigs) rig.destroy();
});
