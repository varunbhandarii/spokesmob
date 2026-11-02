import type { Zone } from "./layout.js";
import { type ParticleCue, ParticlePool } from "./particles.js";

export function createParticleCanvas(root: HTMLElement, seed: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  canvas.className = "particle-canvas";
  canvas.setAttribute("aria-hidden", "true");
  root.prepend(canvas);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Particle canvas unavailable");
  const pool = new ParticlePool(seed);
  const cache = new Map<string, HTMLCanvasElement>();
  const tokens = getComputedStyle(root);
  const paper = tokens.getPropertyValue("--paper").trim();
  const outline = tokens.getPropertyValue("--ink").trim();
  let lastCue = 0;
  const bitmap = (label: string, size: number) => {
    const key = `${String(size)}:${label}`;
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const image = document.createElement("canvas");
    const ink = image.getContext("2d");
    if (!ink) throw new Error("Name bitmap unavailable");
    const font = `${String(size)}px "Atkinson Hyperlegible Next Variable", sans-serif`;
    ink.font = font;
    image.width = Math.ceil(ink.measureText(label).width) + 8;
    image.height = Math.ceil(size * 1.5) + 4;
    ink.font = font;
    ink.textBaseline = "middle";
    ink.lineWidth = 3;
    ink.lineJoin = "round";
    ink.strokeStyle = outline;
    ink.fillStyle = paper;
    ink.strokeText(label, 4, image.height / 2);
    ink.fillText(label, 4, image.height / 2);
    cache.set(key, image);
    if (cache.size > 512) cache.delete(cache.keys().next().value as string);
    return image;
  };
  return {
    canvas,
    draw(
      now: number,
      dt: number,
      zone: Zone,
      mouth: { x: number; y: number },
      cues: readonly ParticleCue[],
    ) {
      for (const cue of cues) {
        if (cue.id <= lastCue) continue;
        lastCue = cue.id;
        if (cue.type === "clear") pool.clear();
        else if (cue.type === "gather") pool.gather(cue.names, now);
        else
          pool.spawn(cue.names, zone, now, (label, size) => {
            const image = bitmap(label, size);
            return { width: image.width, height: image.height };
          });
      }
      pool.update(now, dt, zone, mouth);
      context.clearRect(0, 0, 1920, 1080);
      for (const p of pool.items)
        if (p.active) {
          context.globalAlpha = p.alpha;
          context.drawImage(bitmap(p.label, p.size), p.x, p.y);
        }
      context.globalAlpha = 1;
      canvas.dataset.count = String(pool.count);
    },
    newestPosition: () => pool.newestPosition(),
    invalidate: () => cache.clear(),
    destroy() {
      pool.clear();
      cache.clear();
      canvas.remove();
    },
  };
}
