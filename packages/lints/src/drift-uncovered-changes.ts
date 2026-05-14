import { computeCoverage } from "./coverage.js";
import type { Lint } from "./types.js";

/**
 * Lint that surfaces uncovered drift (ADR-090). Requires `ctx.docoRoot`
 * to walk git. When the context is missing (e.g., running purely against
 * an in-memory cache for unit tests), the lint emits nothing — no false
 * positives.
 */
export const lintDriftUncoveredChanges: Lint = async (_c, _docoId, ctx) => {
  if (!ctx?.docoRoot) return [];
  const report = computeCoverage(ctx.docoRoot);
  if (report.uncovered.length === 0) return [];
  return [
    {
      lintId: "drift-uncovered-changes",
      severity: "warning",
      source: ctx.docoRoot,
      message: `${report.uncovered.length} file(s) modified in working tree are not referenced by any Action. Sample: ${report.uncovered.slice(0, 3).join(", ")}${report.uncovered.length > 3 ? ", …" : ""}.`,
    },
  ];
};
