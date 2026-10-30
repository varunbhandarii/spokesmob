import type { Mood } from "../../../../packages/core/src/types.js";

export type MouthShape = "closed" | "mid" | "open" | "wide" | "o";
export type FacePose =
  | "idle"
  | "thinking"
  | "inhale"
  | "speaking"
  | "aside"
  | "settle"
  | "reading"
  | "muted"
  | "asleep";
export interface FaceRig {
  readonly element: SVGSVGElement;
  setPose(pose: FacePose): void;
  setMood(mood: Mood | null): void;
  setHype(level: number | null): void;
  setMouth(openness: number, shape: MouthShape): void;
  lookAt(x: number, y: number): void;
  update(nowMs: number): void;
  destroy(): void;
}
