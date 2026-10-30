import { expect, test } from "vitest";
import { LAYOUTS } from "./layout.js";
import { PARTICLE_LIMIT, ParticlePool, particleLabel } from "./particles.js";

test("the preallocated particle pool stays bounded and truncates by Unicode characters", () => {
  const pool = new ParticlePool(42);
  const references = [...pool.items];
  pool.spawn(
    Array.from({ length: 600 }, (_, i) => `Viewer${String(i)}`),
    LAYOUTS.wide.particles,
    0,
  );
  expect(pool.count).toBe(PARTICLE_LIMIT);
  expect(pool.items.every((p, i) => p === references[i])).toBe(true);
  expect(Array.from(particleLabel("LongName".repeat(8)))).toHaveLength(24);
  expect(Array.from(particleLabel("\ud83c\udf3f".repeat(30)))).toHaveLength(24);
});
test("particle drift is seeded and stays within every layout band", () => {
  for (const layout of Object.values(LAYOUTS)) {
    const a = new ParticlePool(123),
      b = new ParticlePool(123);
    a.spawn(["LanternFox", "MossPilot"], layout.particles, 0);
    b.spawn(["LanternFox", "MossPilot"], layout.particles, 0);
    for (let now = 16; now < 5000; now += 16) {
      a.update(now, 16, layout.particles, { x: 0, y: 0 });
      b.update(now, 16, layout.particles, { x: 0, y: 0 });
    }
    expect(a.items).toEqual(b.items);
    for (const p of a.items.filter((item) => item.active)) {
      expect(p.x).toBeGreaterThanOrEqual(layout.particles.x);
      expect(p.x + p.width).toBeLessThanOrEqual(layout.particles.x + layout.particles.width);
      expect(p.y).toBeGreaterThanOrEqual(layout.particles.y);
      expect(p.y + p.height).toBeLessThanOrEqual(layout.particles.y + layout.particles.height);
    }
  }
});
test("only cited full names gather into the mouth and clear removes every particle", () => {
  const pool = new ParticlePool(1);
  const zone = LAYOUTS.wide.particles;
  pool.spawn(["LanternFox", "MossPilot"], zone, 0);
  pool.gather(["lanternfox"], 100);
  expect(pool.items.filter((p) => p.gathering !== null).map((p) => p.name)).toEqual(["LanternFox"]);
  pool.update(1000, 16, zone, { x: 200, y: 900 });
  expect(pool.count).toBe(1);
  expect(pool.items.find((p) => p.name === "LanternFox")?.active).toBe(false);
  pool.clear();
  expect(pool.count).toBe(0);
  expect(pool.newestPosition()).toBeNull();
});
