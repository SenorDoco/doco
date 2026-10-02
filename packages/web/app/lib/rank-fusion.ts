// Reciprocal rank fusion of several rankings of the same ids: each id scores
// Σ w / (k + rank) over the rankings that list it, so being near the top of
// two lists beats leading one. k = 60 is the standard damping. A ranking's
// weight (default 1) scales its say: a ranking that lists everything, such as
// recency or PageRank, is usually given less than a ranking of matches. Pure.

export const RRF_K = 60;

export function fuseRankings(
  rankings: readonly (readonly string[])[],
  k = RRF_K,
  weights: readonly number[] = [],
): string[] {
  const scores = new Map<string, number>();
  rankings.forEach((ranking, i) => {
    const weight = weights[i] ?? 1;
    const seen = new Set<string>();
    ranking.forEach((id, rank) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
    });
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}
