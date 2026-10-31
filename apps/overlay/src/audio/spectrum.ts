export function lowBandShare(decibels: ArrayLike<number>, hzPerBin: number): number {
  if (!Number.isFinite(hzPerBin) || hzPerBin <= 0) return 0;
  let low = 0,
    total = 0;
  for (
    let i = Math.max(1, Math.ceil(80 / hzPerBin));
    i < decibels.length && i * hzPerBin <= 4000;
    i++
  ) {
    const db = decibels[i];
    if (db === undefined || !Number.isFinite(db)) continue;
    const power = 10 ** (Math.min(0, db) / 10);
    total += power;
    if (i * hzPerBin <= 500) low += power;
  }
  return total > 0 ? low / total : 0;
}
