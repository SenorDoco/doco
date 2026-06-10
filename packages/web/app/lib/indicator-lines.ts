// Ready-to-paste Doco indicator lines, built server-side so an agent never has
// to MANUFACTURE the protocol format from rules held in memory across a turn.
//
// The capture endpoints already hand back `footer_lines` for invariant #2 (the
// after-a-write line). The two invariants agents miss most — the "N found" line
// (canonical instructions §1) and the closing tally (§3) — were the two that
// were NOT handed over as finished strings: search returned `indicator_prefix`,
// `count`, and `duration_ms` and asked the agent to assemble them. This builds
// those exact lines so the instruction collapses from "construct this format"
// to "paste this string verbatim" — the same proven shape as `footer_lines`.
//
// Pure string formatting, no server deps — unit-tested in isolation.

export interface DocoSearchDisplay {
  /** The credential-aware prefix, e.g. `[🔮 Doco nick on behalf of @user]`. */
  prefix: string;
  /** Invariant §1, post-search: `<prefix> <N> relevant nodes found (<X.X>s)`. */
  found: string;
  /**
   * Invariant §3, end-of-turn: `<prefix> <label>: **<N>** nodes added/updated`.
   * Built for a READ-ONLY turn (N = 0) — the common case agents drop the tally
   * on. If the turn also captured nodes, bump the count from the capture
   * `footer_lines` (each footer line is one captured/updated node).
   */
  tally: string;
}

/** Fallback prefix before any credential is known (cold, unauthenticated). */
export const DEFAULT_INDICATOR_PREFIX = "[🔮 Doco]";

export function buildSearchDisplay(args: {
  indicatorPrefix?: string | null;
  count: number;
  durationMs: number;
  /** Tally source label — the doco handle just queried. */
  label: string;
}): DocoSearchDisplay {
  const prefix = args.indicatorPrefix?.trim() || DEFAULT_INDICATOR_PREFIX;
  const seconds = (Math.max(0, args.durationMs) / 1000).toFixed(1);
  const count = Math.max(0, Math.trunc(args.count));
  return {
    prefix,
    found: `${prefix} ${count} relevant nodes found (${seconds}s)`,
    tally: `${prefix} ${args.label}: **0** nodes added/updated`,
  };
}
