import type { Mood } from "../../../../packages/core/src/types.js";
import { seededRandom } from "../view/random.js";
import type { FacePose, FaceRig, MouthShape } from "./types.js";
import "./face.css";

const clamp = (value: number, low = 0, high = 1) =>
  Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : low;
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}
const POSES: Record<FacePose, { y: number; angle: number; scale: number }> = {
  idle: { y: 0, angle: 0, scale: 1 },
  thinking: { y: -5, angle: -5, scale: 1 },
  inhale: { y: -8, angle: 0, scale: 1.025 },
  speaking: { y: 0, angle: 0, scale: 1 },
  aside: { y: 2, angle: 8, scale: 0.97 },
  settle: { y: 5, angle: 0, scale: 0.98 },
  reading: { y: 0, angle: -2, scale: 1 },
  muted: { y: 0, angle: 0, scale: 1 },
  asleep: { y: 12, angle: 5, scale: 0.97 },
};
export function createFace(options: { seed: number; size: number }): FaceRig {
  const random = seededRandom(options.seed);
  const element = svg("svg", {
    viewBox: "0 0 512 512",
    width: options.size,
    height: options.size,
    "aria-label": "Spokesmob face",
    role: "img",
  });
  element.classList.add("placeholder-face");
  const body = svg("g");
  const head = svg("circle", { cx: 256, cy: 256, r: 218, class: "face-head" });
  const rim = svg("circle", { cx: 256, cy: 256, r: 235, class: "face-rim" });
  const eyes = svg("g");
  const eyeMood = svg("g", { class: "face-lids" });
  const pupils = svg("g");
  for (const x of [175, 337]) {
    eyeMood.append(svg("ellipse", { cx: x, cy: 227, rx: 39, ry: 49, class: "face-eye" }));
    pupils.append(svg("circle", { cx: x, cy: 231, r: 16, class: "face-pupil" }));
  }
  eyeMood.append(pupils);
  eyes.append(eyeMood);
  const brows = svg("g", { class: "face-brows" });
  brows.append(svg("path", { d: "M136 158 Q173 140 210 156 M302 156 Q339 140 376 158" }));
  const cheeks = svg("g", { class: "face-cheeks" });
  for (const x of [123, 389]) cheeks.append(svg("ellipse", { cx: x, cy: 296, rx: 33, ry: 18 }));
  const mouth = svg("g");
  const shapes = new Map<MouthShape, SVGElement>();
  for (const [shape, rx, ry] of [
    ["closed", 42, 3],
    ["mid", 43, 16],
    ["open", 47, 36],
    ["wide", 74, 42],
    ["o", 26, 43],
  ] as const) {
    const part = svg("ellipse", { cx: 256, cy: 345, rx, ry, class: "face-mouth" });
    shapes.set(shape, part);
    mouth.append(part);
  }
  const zip = svg("g", { class: "face-zip" });
  zip.append(
    svg("path", {
      d: "M188 345 H324 M200 333 V357 M222 333 V357 M244 333 V357 M266 333 V357 M288 333 V357 M310 333 V357",
    }),
  );
  body.append(rim, head, cheeks, eyes, brows, mouth, zip);
  element.append(body);
  let pose: FacePose = "idle";
  const current = { ...POSES.idle };
  let mood: Mood | null | undefined;
  let hype: number | null | undefined;
  let openness = 0;
  let shape: MouthShape = "closed";
  let gaze = { x: 0, y: 0 };
  let last: number | null = null;
  let blinkAt = 2500 + random() * 3500;
  let destroyed = false;
  const rig: FaceRig = {
    element,
    setPose(value) {
      pose = value;
      element.dataset.pose = value;
    },
    setMood(value) {
      if (mood === value) return;
      mood = value;
      element.dataset.mood = value ?? "neutral";
    },
    setHype(value) {
      if (hype === value) return;
      hype = value;
      element.dataset.hype = value === null ? "off" : "on";
    },
    setMouth(value, next) {
      openness = clamp(value);
      shape = next;
    },
    lookAt(x, y) {
      gaze = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    },
    update(now) {
      if (destroyed || !Number.isFinite(now)) return;
      const dt = last === null ? 200 : clamp(now - last, 0, 100);
      last = now;
      const mix = 1 - Math.exp(-dt / 60);
      const target = POSES[pose];
      current.y += (target.y - current.y) * mix;
      current.angle += (target.angle - current.angle) * mix;
      current.scale += (target.scale - current.scale) * mix;
      const drift = Math.sin(now / 1600) * 2;
      body.setAttribute(
        "transform",
        "translate(0 " +
          (current.y + drift) +
          ") translate(256 256) rotate(" +
          current.angle +
          ") scale(" +
          current.scale +
          ") translate(-256 -256)",
      );
      if (now > blinkAt + 160) blinkAt = now + 2800 + random() * 4000;
      const blink = now >= blinkAt ? Math.max(0.06, Math.abs(now - blinkAt - 80) / 80) : 1;
      const lids = pose === "asleep" ? 0.05 : blink;
      eyes.setAttribute("transform", `translate(0 227) scale(1 ${lids}) translate(0 -227)`);
      pupils.setAttribute("transform", `translate(${gaze.x * 12} ${gaze.y * 9})`);
      for (const [key, part] of shapes) {
        part.style.opacity = pose === "muted" ? "0" : key === shape ? "1" : "0";
      }
      mouth.setAttribute(
        "transform",
        "translate(0 345) scale(1 " +
          (shape === "closed" ? 1 : Math.max(0.08, openness)) +
          ") translate(0 -345)",
      );
      zip.style.opacity = pose === "muted" ? "1" : "0";
      element.dataset.mouth = shape;
      element.dataset.openness = String(openness);
    },
    destroy() {
      destroyed = true;
      element.remove();
    },
  };
  rig.setMood(null);
  rig.setHype(null);
  rig.setPose("idle");
  rig.update(0);
  return rig;
}
export type { FacePose, FaceRig, MouthShape } from "./types.js";
