// Compact relative-time formatting for table cells: "5m ago", "3h ago",
// "2d ago", "6mo ago", "1y ago". Returns "—" for null/missing inputs.
//
// Bucket boundaries pick the nearest unit that's >= the supplied bucket
// (e.g. 90 seconds → "1m ago", 90 minutes → "1h ago"). This is intentionally
// less precise than Intl.RelativeTimeFormat so tables stay narrow.

export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = new Date(iso);
  const ms = now.getTime() - then.getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}
