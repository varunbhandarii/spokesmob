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
  vote: Zone;
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
    caption: zone(400, 792, 1080, 178, 50),
    vote: zone(430, 740, 1000, 292, 38),
    meter: zone(1100, 750, 420, 92, 24),
    dissent: zone(430, 982, 1100, 60, 30),
    counter: zone(48, 1008, 300, 40, 24),
    question: zone(300, 48, 1320, 116, 44),
    badge: zone(190, 704, 172, 42, 18),
    particles: zone(0, 600, 900, 480),
    qr: null,
    bar: null,
  },
  stage: {
    margin: 64,
    face: zone(660, 150, 600, 600),
    caption: zone(240, 794, 1440, 144, 68),
    vote: zone(340, 716, 1240, 300, 46),
    meter: zone(1260, 724, 496, 98, 30),
    dissent: zone(240, 952, 1440, 72, 38),
    counter: zone(64, 224, 480, 180, 100),
    question: zone(220, 64, 1480, 122, 58),
    badge: zone(1100, 190, 172, 42, 20),
    particles: zone(0, 0, 1920, 1080),
    qr: zone(1510, 330, 346, 410, 18),
    bar: null,
  },
  compact: {
    margin: 32,
    face: zone(40, 870, 180, 180),
    caption: zone(260, 918, 1300, 116, 36),
    vote: zone(260, 834, 1540, 204, 30),
    meter: zone(1060, 870, 510, 60, 22),
    dissent: zone(250, 1000, 1350, 38, 28),
    counter: zone(1632, 958, 224, 64, 28),
    question: zone(260, 786, 1300, 106, 30),
    badge: zone(95, 868, 168, 42, 18),
    particles: zone(32, 838, 1856, 210),
    qr: null,
    bar: zone(32, 838, 1856, 210),
  },
};
