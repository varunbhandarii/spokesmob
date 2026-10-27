import { THRESHOLDS } from "./thresholds.js";
import type { Cluster } from "./types.js";

export function citedAuthors(clusters: readonly Pick<Cluster, "authorIds">[]): string[] {
  return [...new Set(clusters.flatMap((cluster) => cluster.authorIds))].sort();
}
export function agreement(
  clusters: readonly Pick<Cluster, "authorIds">[],
  voices: number,
): { pct: number; voices: number; authorIds: string[]; display: string } {
  const authorIds = citedAuthors(clusters);
  const pct = voices > 0 ? Math.round((100 * authorIds.length) / voices) : 0;
  return { pct, voices, authorIds, display: `${pct}% of ${voices} voices` };
}
export function band(share: number): "most" | "a_lot" | "some" {
  return share >= THRESHOLDS.MAJORITY_SHARE ? "most" : share >= 0.25 ? "a_lot" : "some";
}
