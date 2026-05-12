import { defineCommand } from "citty";
import { computeCoverage } from "@doco/lints";
import { findDocoRoot } from "../find-root.js";
import { c, checkmark, cross, header, rule } from "../output.js";

export const coverageCmd = defineCommand({
  meta: {
    name: "coverage",
    description: "Report modified files not referenced by any Action — drift candidates (ADR-090).",
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

    const report = computeCoverage(root, {
      ...(args.since !== undefined ? { sinceRef: args.since as string } : {}),
      includeIgnored: args["include-ignored"] as boolean,
    });

    if (report.modified.length === 0) {
      console.log(checkmark("Working tree clean — no drift to check."));
      return;
    }

    console.log();
    console.log(header("Doco coverage"));
    console.log(rule());
    console.log(checkmark(`Modified files:     ${report.modified.length}`));
    console.log(checkmark(`Covered by Actions: ${c.dim(String(report.covered.length))}`));
    console.log(rule());
    if (report.uncovered.length === 0) {
      console.log(checkmark("All modified files appear in at least one Action."));
      return;
    }
    console.log(cross(`Uncovered files (${report.uncovered.length}):`));
    for (const f of report.uncovered.slice(0, 50)) {
      console.log(`    ${c.warn(f)}`);
    }
    if (report.uncovered.length > 50)
      console.log(c.dim(`    … (${report.uncovered.length - 50} more)`));
    console.log();
    console.log(
      c.dim(
        "Capture the work as an Action under actions/ — verb + outputs + the file paths above.",
      ),
    );
    process.exitCode = 1;
  },
});
