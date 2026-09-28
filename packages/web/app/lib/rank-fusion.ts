// Reciprocal rank fusion of several rankings of the same ids: each id scores
// Σ 1 / (k + rank) over the rankings that list it, so being near the top of
// two lists beats leading one. k = 60 is the standard damping. Pure.

export const RRF_K = 60;

export function fuseRankings(rankings: readonly (readonly string[])[], k = RRF_K): string[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    ranking.forEach((id, rank) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}
