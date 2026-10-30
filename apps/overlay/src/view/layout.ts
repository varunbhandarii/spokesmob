import type { Layout } from "../../../../packages/core/src/beat-types.js";

export interface Zone {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}
export interface LayoutZones {
  face: Zone;
  caption: Zone;
  meter: Zone;
  dissent: Zone;
  counter: Zone;
  question: Zone;
  badge: Zone;
  particles: Zone;
  qr: Zone | null;
  bar: Zone | null;
  margin: number;
}
const zone = (x: number, y: number, width: number, height: number, fontSize = 0): Zone => ({
  x,
  y,
  width,
  height,
  fontSize,
});
export const LAYOUTS: Readonly<Record<Layout, LayoutZones>> = {
  wide: {
    margin: 48,
    face: zone(48, 712, 300, 300),
    caption: zone(380, 850, 1160, 130, 48),
    meter: zone(1280, 778, 260, 60, 32),
    dissent: zone(380, 988, 1160, 36, 30),
    counter: zone(48, 1004, 300, 28, 28),
    question: zone(300, 48, 1320, 70, 40),
    badge: zone(130, 976, 140, 28, 18),
    particles: zone(0, 600, 900, 480),
    qr: null,
    bar: null,
  },
  stage: {
    margin: 64,
    face: zone(660, 150, 600, 600),
    caption: zone(210, 780, 1500, 176, 72),
    meter: zone(1260, 696, 450, 72, 56),
    dissent: zone(210, 968, 1500, 54, 44),
    counter: zone(64, 184, 540, 150, 120),
    question: zone(220, 64, 1480, 80, 64),
    badge: zone(860, 698, 200, 36, 24),
    particles: zone(0, 0, 1920, 1080),
    qr: zone(1576, 300, 280, 280, 18),
    bar: null,
  },
  compact: {
    margin: 32,
    face: zone(40, 870, 180, 180),
    caption: zone(250, 882, 1350, 120, 36),
    meter: zone(1632, 870, 224, 70, 28),
    dissent: zone(250, 1000, 1350, 38, 28),
    counter: zone(1632, 958, 224, 64, 28),
    question: zone(250, 840, 1350, 38, 28),
    badge: zone(70, 1020, 130, 24, 18),
    particles: zone(32, 838, 1856, 210),
    qr: null,
    bar: zone(32, 838, 1856, 210),
  },
};
