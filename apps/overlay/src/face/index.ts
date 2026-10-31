import type { Mood } from "../../../../packages/core/src/types.js";
import { seededRandom } from "../view/random.js";
import { createArtwork } from "./artwork.js";
import type { FacePose, FaceRig, MouthShape } from "./types.js";
import "./face.css";

const clamp = (value: number, low = 0, high = 1) =>
  Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : low;

const REST = {
  x: 0,
  y: 0,
  angle: 0,
  sx: 1,
  sy: 1,
  leftLid: 1,
  rightLid: 1,
  leftBrowY: 0,
  rightBrowY: 0,
  leftBrowAngle: 0,
  rightBrowAngle: 0,
  gazeX: 0,
  gazeY: 0,
  mouthX: 0,
  mouthY: 0,
  mouthScale: 1,
  thinking: 0,
  inhale: 0,
  aside: 0,
  settle: 0,
  reading: 0,
  zip: 0,
  sleep: 0,
};
type Posture = typeof REST;
const posture = (values: Partial<Posture>): Posture => ({ ...REST, ...values });
const POSES: Record<FacePose, Posture> = {
  idle: posture({}),
  thinking: posture({
    y: -4,
    angle: -8,
    leftLid: 0.72,
    leftBrowY: 9,
    rightBrowY: -14,
    leftBrowAngle: 12,
    rightBrowAngle: -12,
    gazeX: 0.55,
    gazeY: -0.65,
    mouthX: -15,
    thinking: 1,
  }),
  inhale: posture({
    y: -10,
    sx: 1.025,
    sy: 1.035,
    leftLid: 1.12,
    rightLid: 1.12,
    leftBrowY: -15,
    rightBrowY: -15,
    mouthY: 5,
    inhale: 1,
  }),
  speaking: posture({
    y: -3,
    leftBrowY: -5,
    rightBrowY: -7,
    leftBrowAngle: -4,
    rightBrowAngle: 4,
    sy: 1.01,
  }),
  aside: posture({
    x: 7,
    y: 4,
    angle: 9,
    sx: 0.95,
    sy: 0.97,
    leftLid: 0.66,
    rightLid: 0.84,
    leftBrowY: 4,
    rightBrowY: -5,
    rightBrowAngle: 8,
    gazeX: -0.3,
    mouthX: -11,
    mouthScale: 0.86,
    aside: 1,
  }),
  settle: posture({
    y: 10,
    sx: 1.035,
    sy: 0.95,
    leftLid: 0.57,
    rightLid: 0.57,
    leftBrowY: 7,
    rightBrowY: 7,
    gazeY: 0.15,
    mouthY: -3,
    settle: 1,
  }),
  reading: posture({
    y: 3,
    angle: -3,
    leftLid: 0.8,
    rightLid: 0.8,
    leftBrowY: 5,
    rightBrowY: 5,
    leftBrowAngle: -8,
    rightBrowAngle: 8,
    gazeY: 0.85,
    reading: 1,
  }),
  muted: posture({
    leftLid: 0.82,
    rightLid: 0.82,
    leftBrowY: 3,
    rightBrowY: 3,
    zip: 1,
  }),
  asleep: posture({
    y: 13,
    angle: 10,
    sx: 1.015,
    sy: 0.95,
    leftLid: 0,
    rightLid: 0,
    leftBrowY: 12,
    rightBrowY: 12,
    mouthScale: 0.8,
    sleep: 1,
  }),
};

function transform(node: SVGElement, x: number, y: number, angle = 0, sx = 1, sy = sx) {
  node.setAttribute("transform", `translate(${x} ${y}) rotate(${angle}) scale(${sx} ${sy})`);
}
const opacity = (node: SVGElement, value: number) => node.setAttribute("opacity", String(value));

export function createFace(options: { seed: number; size: number }): FaceRig {
  const art = createArtwork(options.size);
  const { element } = art;
  const random = seededRandom(options.seed);
  const driftOffset = random() * Math.PI * 2;
  const driftPeriod = 1700 + random() * 700;
  let blinkAt = 2800 + random() * 3200;
  let pose: FacePose = "idle";
  const current = { ...REST };
  let from = { ...REST };
  let poseStart = 0;
  let last = 0;
  let gazeX = 0;
  let gazeY = 0;
  let targetX = 0;
  let targetY = 0;
  let openness = 0;
  let shape: MouthShape = "closed";
  let hype = 0;
  let destroyed = false;

  const rig: FaceRig = {
    element,
    setPose(value) {
      if (destroyed || pose === value) return;
      from = { ...current };
      poseStart = last;
      pose = value;
      element.dataset.pose = value;
    },
    setMood(value: Mood | null) {
      if (!destroyed) element.dataset.mood = value ?? "neutral";
    },
    setHype(value) {
      if (destroyed) return;
      hype = value === null ? 0 : 0.3 + clamp(value, 0, 5) * 0.1;
      element.dataset.hype = value === null ? "off" : "on";
    },
    setMouth(value, next) {
      if (destroyed) return;
      openness = clamp(value);
      shape = next;
    },
    lookAt(x, y) {
      if (destroyed) return;
      targetX = clamp(x, -1, 1);
      targetY = clamp(y, -1, 1);
    },
    update(nowMs) {
      if (destroyed || !Number.isFinite(nowMs)) return;
      const now = Math.max(last, nowMs);
      const dt = now - last;
      last = now;
      // A finite, interruptible 200 ms transition also settles on a single harness seek.
      const progress = clamp((now - poseStart) / 200);
      const ease = progress * progress * (3 - 2 * progress);
      const target = POSES[pose];
      for (const key of Object.keys(REST) as (keyof Posture)[]) {
        current[key] = from[key] + (target[key] - from[key]) * ease;
      }
      const follow = 1 - Math.exp(-dt / 45);
      gazeX += (targetX - gazeX) * follow;
      gazeY += (targetY - gazeY) * follow;
      const drift = Math.sin(now / driftPeriod + driftOffset);
      const breath = Math.sin(now / 1100 + driftOffset);
      transform(
        art.body,
        256 + current.x,
        256 + current.y + drift * 1.6 + current.sleep * breath * 1.5,
        current.angle + drift * 0.35,
        current.sx,
        current.sy,
      );

      // At most one gentle blink per 2.8 seconds; no timer, frame loop or clock read.
      if (now > blinkAt + 180) blinkAt = now + 2800 + random() * 4200;
      const blink = now >= blinkAt ? Math.abs(now - blinkAt - 90) / 90 : 1;
      for (const [index, eye] of art.eyes.entries()) {
        const lid = index === 0 ? current.leftLid : current.rightLid;
        const opening = Math.max(0, lid * blink);
        transform(eye.open, 0, 0, 0, 1, Math.max(0.025, opening));
        opacity(eye.open, clamp(opening * 8));
        opacity(eye.closed, 1 - clamp(opening * 4));
        transform(
          eye.pupil,
          clamp(gazeX + current.gazeX, -1, 1) * 14,
          clamp(gazeY + current.gazeY, -1, 1) * 11,
        );
        transform(
          eye.browPose,
          0,
          index === 0 ? current.leftBrowY : current.rightBrowY,
          index === 0 ? current.leftBrowAngle : current.rightBrowAngle,
        );
      }

      // Pose articulation wraps the mouth; it never chooses its shape or envelope.
      transform(art.mouth, 256 + current.mouthX, 344 + current.mouthY, 0, current.mouthScale);
      for (const [key, part] of art.mouths) {
        opacity(part, key === shape ? 1 : 0);
        transform(part, 0, 0, 0, 1, key === "closed" ? 1 : 0.12 + openness * 0.88);
      }
      opacity(art.mouth, 1 - current.zip);
      opacity(art.zip, current.zip);
      opacity(art.gold, hype);
      for (const key of ["thinking", "inhale", "aside", "settle", "reading", "sleep"] as const)
        opacity(art.accents[key], current[key]);
      element.dataset.mouth = shape;
      element.dataset.openness = String(openness);
    },
    destroy() {
      destroyed = true;
      element.remove();
    },
  };
  element.dataset.pose = pose;
  rig.setMood(null);
  rig.setHype(null);
  rig.update(0);
  return rig;
}
export type { FacePose, FaceRig, MouthShape } from "./types.js";
