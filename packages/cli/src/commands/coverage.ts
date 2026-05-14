import { defineCommand } from "citty";
import { computeCoverage } from "@doco/lints";
import { findDocoRoot } from "../find-root.js";
import { c, checkmark, cross, header, rule } from "../output.js";

export const coverageCmd = defineCommand({
  meta: {
    name: "coverage",
    description:
      "Report modified files not referenced by any Action (ADR-090) AND files mentioned by an existing Decision body that would be the right PATCH target (ADR-141).",
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
    "block-patch-candidates": {
      type: "boolean",
      description:
        "Exit 1 if the working tree contains files that an existing Decision body mentions (PATCH-candidates). Off by default — meant for pre-commit use when the project wants the PATCH-or-document rule enforced as a soft block.",
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
    console.log(checkmark(`Modified files:        ${report.modified.length}`));
    console.log(checkmark(`Covered by Actions:    ${c.dim(String(report.covered.length))}`));
    console.log(
      checkmark(`PATCH-candidates:      ${c.dim(String(report.patchCandidates.length))}`),
    );
    console.log(rule());

    let didFail = false;

    if (report.uncovered.length > 0) {
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
      console.log();
      didFail = true;
    } else {
      console.log(checkmark("All modified files appear in at least one Action."));
    }

    if (report.patchCandidates.length > 0) {
      console.log();
      console.log(
        cross(
          `PATCH-candidates (${report.patchCandidates.length}) — existing Decisions reference these files. Consider extending instead of opening siblings:`,
        ),
      );
      for (const candidate of report.patchCandidates.slice(0, 25)) {
        console.log(`    ${c.warn(candidate.file)}`);
        const previewIds = candidate.decisionIds.slice(0, 3);
        for (const id of previewIds) {
          console.log(
            c.dim(`        → doco patch decision ${id} --append-body "..."`),
          );
        }
        if (candidate.decisionIds.length > previewIds.length) {
          console.log(
            c.dim(
              `        (and ${candidate.decisionIds.length - previewIds.length} more Decision${
                candidate.decisionIds.length - previewIds.length === 1 ? "" : "s"
              })`,
            ),
          );
        }
      }
      if (report.patchCandidates.length > 25) {
        console.log(c.dim(`    … (${report.patchCandidates.length - 25} more)`));
      }
      if (args["block-patch-candidates"] as boolean) {
        didFail = true;
      }
    }

    if (didFail) process.exitCode = 1;
  },
});
