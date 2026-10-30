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
    meter: zone(1160, 778, 380, 60, 32),
    dissent: zone(380, 982, 1160, 50, 30),
    counter: zone(48, 992, 300, 40, 28),
    question: zone(300, 48, 1320, 70, 40),
    badge: zone(228, 724, 120, 32, 18),
    particles: zone(0, 600, 900, 480),
    qr: null,
    bar: null,
  },
  stage: {
    margin: 64,
    face: zone(660, 150, 600, 600),
    caption: zone(210, 780, 1500, 152, 72),
    meter: zone(1260, 676, 596, 92, 56),
    dissent: zone(210, 944, 1500, 72, 44),
    counter: zone(64, 184, 540, 216, 120),
    question: zone(220, 64, 1480, 108, 64),
    badge: zone(1120, 168, 140, 36, 24),
    particles: zone(0, 0, 1920, 1080),
    qr: zone(1576, 300, 280, 280, 18),
    bar: null,
  },
  compact: {
    margin: 32,
    face: zone(40, 870, 180, 180),
    caption: zone(250, 882, 1350, 120, 36),
    meter: zone(1632, 864, 224, 88, 28),
    dissent: zone(250, 1000, 1350, 38, 28),
    counter: zone(1632, 958, 224, 64, 28),
    question: zone(250, 840, 1350, 38, 28),
    badge: zone(110, 882, 110, 30, 18),
    particles: zone(32, 838, 1856, 210),
    qr: null,
    bar: zone(32, 838, 1856, 210),
  },
};
