import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Drift detection (ADR-090).
 *
 * Walks the git working tree under `docoRoot` and reports files that
 * have been touched but aren't referenced in any Action body under
 * `actions/`. Shared by:
 *   - `doco coverage` CLI
 *   - GET /api/v1/agent-bootstrap (uncovered_changes field)
 *   - /coverage web page
 *   - drift-uncovered-changes lint (when enabled)
 */

const IGNORED = new RegExp(
  "(^|/)(pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|\\.DS_Store|" +
    ".+\\.tsbuildinfo|\\.doco/.*|build/.*|dist/.*|node_modules/.*)$",
);

export interface CoverageReport {
  modified: string[];
  covered: string[];
  uncovered: string[];
}

export interface CoverageOptions {
  /** Include a committed range like `HEAD~5`. */
  sinceRef?: string;
  /** Include files matching the standard ignore list. */
  includeIgnored?: boolean;
}

export function computeCoverage(docoRoot: string, opts: CoverageOptions = {}): CoverageReport {
  const modified = Array.from(collectModifiedFiles(docoRoot, opts));
  const actionBlob = readAllActionText(docoRoot);

  const uncovered: string[] = [];
  const covered: string[] = [];
  for (const f of modified) {
    const basename = f.split("/").pop() ?? f;
    if (actionBlob.includes(f) || actionBlob.includes(basename)) covered.push(f);
    else uncovered.push(f);
  }

  return { modified, covered: covered.sort(), uncovered: uncovered.sort() };
}

function collectModifiedFiles(docoRoot: string, opts: CoverageOptions): Set<string> {
  const out = new Set<string>();
  try {
    const status = execSync("git status --porcelain -uall", {
      cwd: docoRoot,
      encoding: "utf8",
    });
    for (const line of status.split("\n")) {
      const path = line.slice(3).trim().replace(/^"|"$/g, "");
      if (!path) continue;
      if (!opts.includeIgnored && IGNORED.test(path)) continue;
      out.add(path);
    }
  } catch {
    // not a repo or git missing
  }
  if (opts.sinceRef) {
    try {
      const diff = execSync(`git diff --name-only ${opts.sinceRef}..HEAD`, {
        cwd: docoRoot,
        encoding: "utf8",
      });
      for (const line of diff.split("\n")) {
        const path = line.trim();
        if (!path) continue;
        if (!opts.includeIgnored && IGNORED.test(path)) continue;
        out.add(path);
      }
    } catch {
      // bad rev range
    }
  }
  return out;
}

function readAllActionText(docoRoot: string): string {
  const dir = join(docoRoot, "actions");
  let blob = "";
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("action_") || !name.endsWith(".md")) continue;
      blob += `\n${readFileSync(join(dir, name), "utf8")}`;
    }
  } catch {
    // no actions/ dir
  }
  return blob;
}
