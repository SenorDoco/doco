import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Drift detection (ADR-090 + ADR-141).
 *
 * Walks the git working tree under `docoRoot` and reports two
 * orthogonal coverage axes:
 *
 * 1. **Action coverage** (ADR-090) — does any Action under `actions/`
 *    reference this file? Missing = the work shipped without a
 *    capturing Action ("uncovered").
 *
 * 2. **Decision PATCH-candidates** (ADR-141) — does any Decision
 *    under `decisions/` reference this file? Hit = there's an
 *    existing entity governing this code; the right move is to
 *    `doco patch decision <id> --append-body "..."` rather than
 *    open a sibling. Surfaced alongside (not instead of) the Action
 *    check.
 *
 * A file may be both — covered by an Action AND a PATCH-candidate.
 * Both calls-to-action are legitimate (capture the work + extend the
 * governing rationale). The CLI surfaces both axes.
 *
 * Shared by:
 *   - `doco coverage` CLI
 *   - GET /api/v1/agent-bootstrap (uncovered_changes field)
 *   - /coverage web page
 *   - drift-uncovered-changes lint (when enabled)
 */

const IGNORED = new RegExp(
  "(^|/)(pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|\\.DS_Store|" +
    ".+\\.tsbuildinfo|\\.doco/.*|build/.*|dist/.*|node_modules/.*)$",
);

export interface PatchCandidate {
  /** Relative path of the modified file. */
  file: string;
  /** Decision ids whose body text references this file. */
  decisionIds: string[];
}

export interface CoverageReport {
  modified: string[];
  covered: string[];
  uncovered: string[];
  /**
   * Files (covered or uncovered) that one or more existing Decision
   * bodies reference. Each entry is a hint that the right capture is
   * `doco patch decision <id> --append-body "..."` rather than (or in
   * addition to) a new Action.
   */
  patchCandidates: PatchCandidate[];
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
  const decisionsById = readDecisionsById(docoRoot);

  const uncovered: string[] = [];
  const covered: string[] = [];
  const patchCandidates: PatchCandidate[] = [];

  for (const f of modified) {
    const basename = f.split("/").pop() ?? f;
    if (actionBlob.includes(f) || actionBlob.includes(basename)) covered.push(f);
    else uncovered.push(f);

    // Independent axis: does any Decision body reference this file?
    const matchingDecisions: string[] = [];
    for (const [id, body] of decisionsById) {
      if (body.includes(f) || body.includes(basename)) matchingDecisions.push(id);
    }
    if (matchingDecisions.length > 0) {
      patchCandidates.push({ file: f, decisionIds: matchingDecisions.sort() });
    }
  }

  return {
    modified,
    covered: covered.sort(),
    uncovered: uncovered.sort(),
    patchCandidates: patchCandidates.sort((a, b) => a.file.localeCompare(b.file)),
  };
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

function readDecisionsById(docoRoot: string): Map<string, string> {
  const dir = join(docoRoot, "decisions");
  const out = new Map<string, string>();
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("decision_") || !name.endsWith(".md")) continue;
      const id = name.replace(/\.md$/, "");
      out.set(id, readFileSync(join(dir, name), "utf8"));
    }
  } catch {
    // no decisions/ dir
  }
  return out;
}
