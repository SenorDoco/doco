import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineCommand } from "citty";
import { findDocoRoot } from "../find-root.js";
import { c, checkmark, cross, header, rule } from "../output.js";

/**
 * `doco coverage` — drift detection (ADR-090).
 *
 * Walks the git working tree (and optionally the last N commits) for
 * modified files, and cross-references them against every Action's body
 * text. Reports the set of files that have been touched but aren't
 * mentioned in any Action — the "uncovered" set, candidates for an
 * Action that hasn't been written.
 *
 * Coverage is heuristic: it grep-matches each modified path's basename
 * (or a tail-fragment) inside every Action file. False positives are
 * acceptable; the goal is to nudge agents/humans into recording work
 * they almost shipped silently.
 */
export const coverageCmd = defineCommand({
  meta: {
    name: "coverage",
    description: "Report modified files not referenced by any Action — drift candidates.",
  },
  args: {
    root: {
      type: "string",
      description: "Doco root (default: walk upward from cwd).",
    },
    since: {
      type: "string",
      description:
        "git revision range tail (e.g. 'HEAD~5'). Includes committed changes since that revision in addition to the working tree.",
    },
    "include-ignored": {
      type: "boolean",
      description: "Include files in the standard ignore list (lockfiles, build outputs).",
      default: false,
    },
  },
  async run({ args }) {
    const root = (args.root as string | undefined) ?? (await findDocoRoot());
    if (!root) {
      console.error(cross("Could not find doco.yaml."));
      process.exitCode = 2;
      return;
    }

    const since = args.since as string | undefined;
    const includeIgnored = args["include-ignored"] as boolean;

    const modifiedSet = collectModifiedFiles(root, since, includeIgnored);
    if (modifiedSet.size === 0) {
      console.log(checkmark("Working tree clean — no drift to check."));
      return;
    }

    const actionBlob = readAllActionText(root);
    const uncovered: string[] = [];
    const covered: string[] = [];
    for (const f of modifiedSet) {
      const basename = f.split("/").pop() ?? f;
      if (actionBlob.includes(f) || actionBlob.includes(basename)) covered.push(f);
      else uncovered.push(f);
    }

    console.log();
    console.log(header("Doco coverage"));
    console.log(rule());
    console.log(checkmark(`Modified files:     ${modifiedSet.size}`));
    console.log(checkmark(`Covered by Actions: ${c.dim(String(covered.length))}`));
    console.log(rule());
    if (uncovered.length === 0) {
      console.log(checkmark("All modified files appear in at least one Action."));
      return;
    }
    console.log(cross(`Uncovered files (${uncovered.length}):`));
    for (const f of uncovered.slice(0, 50).sort()) {
      console.log(`    ${c.warn(f)}`);
    }
    if (uncovered.length > 50) console.log(c.dim(`    … (${uncovered.length - 50} more)`));
    console.log();
    console.log(
      c.dim(
        "Capture the work as an Action under actions/ — verb + outputs + the file paths above.",
      ),
    );
    process.exitCode = 1;
  },
});

// Conservative ignore list — files that change as a byproduct of dev work and
// aren't worth capturing in an Action by themselves.
const IGNORED = new RegExp(
  "(^|/)(pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|\\.DS_Store|" +
    ".+\\.tsbuildinfo|\\.doco/.*|build/.*|dist/.*|node_modules/.*)$",
);

function collectModifiedFiles(root: string, since: string | undefined, includeIgnored: boolean): Set<string> {
  const out = new Set<string>();
  // Working-tree changes (porcelain).
  try {
    const status = execSync("git status --porcelain -uall", { cwd: root, encoding: "utf8" });
    for (const line of status.split("\n")) {
      const path = line.slice(3).trim().replace(/^"|"$/g, "");
      if (!path) continue;
      if (!includeIgnored && IGNORED.test(path)) continue;
      out.add(path);
    }
  } catch {
    // git missing or not a repo — silently skip the working-tree side
  }
  // Committed changes since `since`.
  if (since) {
    try {
      const diff = execSync(`git diff --name-only ${since}..HEAD`, { cwd: root, encoding: "utf8" });
      for (const line of diff.split("\n")) {
        const path = line.trim();
        if (!path) continue;
        if (!includeIgnored && IGNORED.test(path)) continue;
        out.add(path);
      }
    } catch {
      // ignore — bad revision range or other git issue
    }
  }
  return out;
}

function readAllActionText(root: string): string {
  const dir = join(root, "actions");
  let blob = "";
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("action_") || !name.endsWith(".md")) continue;
      blob += `\n${readFileSync(join(dir, name), "utf8")}`;
    }
  } catch {
    // no actions/ dir — empty blob
  }
  return blob;
}
