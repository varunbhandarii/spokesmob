import type { Zone } from "./layout.js";
import { seededRandom } from "./random.js";

export const PARTICLE_LIMIT = 400;
export interface ParticleCue {
  id: number;
  type: "spawn" | "gather" | "clear";
  names: readonly string[];
}
export interface NameParticle {
  active: boolean;
  name: string;
  label: string;
  size: number;
  width: number;
  height: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  until: number;
  gathering: number | null;
  fromX: number;
  fromY: number;
  alpha: number;
}
export function particleLabel(name: string): string {
  const points = Array.from(name);
  return points.length <= 24 ? name : `${points.slice(0, 23).join("")}\u2026`;
}
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
export class ParticlePool {
  readonly items: NameParticle[] = Array.from({ length: PARTICLE_LIMIT }, () => ({
    active: false,
    name: "",
    label: "",
    size: 16,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    born: 0,
    until: 0,
    gathering: null,
    fromX: 0,
    fromY: 0,
    alpha: 0,
  }));
  private readonly random: () => number;
  private cursor = 0;
  private newest: NameParticle | null = null;
  constructor(seed: number) {
    this.random = seededRandom(seed);
  }
  spawn(
    names: readonly string[],
    zone: Zone,
    now: number,
    measure: (text: string, size: number) => { width: number; height: number } = (text, size) => ({
      width: Array.from(text).length * size * 0.65,
      height: size * 1.4,
    }),
  ) {
    for (const name of names) {
      const p = this.items[this.cursor++ % PARTICLE_LIMIT];
      if (!p) continue;
      const label = particleLabel(name);
      const size = 14 + Math.floor(this.random() * 5);
      const dimensions = measure(label, size);
      const left = zone.x + 4,
        right = Math.max(left, zone.x + zone.width - dimensions.width - 4);
      const top = zone.y + 4,
        bottom = Math.max(top, zone.y + zone.height - dimensions.height - 4);
      const edge = Math.floor(this.random() * 4);
      const x = edge === 0 ? left : edge === 1 ? right : left + this.random() * (right - left);
      const y = edge === 2 ? top : edge === 3 ? bottom : top + this.random() * (bottom - top);
      Object.assign(p, {
        active: true,
        name,
        label,
        size,
        ...dimensions,
        x,
        y,
        vx: (this.random() - 0.5) * 32,
        vy: (this.random() - 0.5) * 22,
        born: now,
        until: now + 12000 + this.random() * 8000,
        gathering: null,
        fromX: x,
        fromY: y,
        alpha: 0.8,
      });
      this.newest = p;
    }
  }
  gather(names: readonly string[], now: number) {
    const cited = new Set(names.map((name) => name.toLowerCase()));
    for (const p of this.items)
      if (p.active && cited.has(p.name.toLowerCase())) {
        p.gathering = now;
        p.fromX = p.x;
        p.fromY = p.y;
      }
  }
  clear() {
    for (const p of this.items) p.active = false;
    this.newest = null;
  }
  update(now: number, dtMs: number, zone: Zone, mouth: { x: number; y: number }) {
    const seconds = Math.max(0, Math.min(100, dtMs)) / 1000;
    for (const p of this.items) {
      if (!p.active) continue;
      if (p.gathering !== null) {
        const share = clamp((now - p.gathering) / 900, 0, 1);
        const ease = share ** 2;
        p.x = p.fromX + (mouth.x - p.width / 2 - p.fromX) * ease;
        p.y = p.fromY + (mouth.y - p.height / 2 - p.fromY) * ease;
        p.alpha = 0.9 * (1 - share);
        if (share >= 1) p.active = false;
      } else {
        const right = Math.max(zone.x + 4, zone.x + zone.width - p.width - 4);
        const bottom = Math.max(zone.y + 4, zone.y + zone.height - p.height - 4);
        const x = p.x + p.vx * seconds,
          y = p.y + p.vy * seconds;
        if (x < zone.x + 4 || x > right) p.vx *= -1;
        if (y < zone.y + 4 || y > bottom) p.vy *= -1;
        p.x = clamp(x, zone.x + 4, right);
        p.y = clamp(y, zone.y + 4, bottom);
        p.alpha = 0.8 * clamp((p.until - now) / 1000, 0, 1);
        if (now >= p.until) p.active = false;
      }
    }
  }
  get count() {
    return this.items.reduce((sum, p) => sum + Number(p.active), 0);
  }
  newestPosition(): { x: number; y: number } | null {
    return this.newest?.active ? { x: this.newest.x, y: this.newest.y } : null;
  }
}
