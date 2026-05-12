import { defineCommand } from "citty";
import { openDb, reindex } from "@doco/index";
import { runAllLints } from "@doco/lints";
import { findDocoRoot } from "../find-root.js";
import { c, checkmark, cross, header, rule } from "../output.js";

export const lintCmd = defineCommand({
  meta: {
    name: "lint",
    description: "Run all built-in system lints against the local index.",
  },
  args: {
    root: { type: "string", description: "Path to the Doco root (default: walk upward from cwd)." },
    "no-reindex": {
      type: "boolean",
      description: "Skip the reindex; use the existing .doco/cache.db.",
      default: false,
    },
    json: { type: "boolean", description: "Emit JSON.", default: false },
  },
  async run({ args }) {
    const rootArg = (args.root as string | undefined) ?? undefined;
    const root = rootArg ?? (await findDocoRoot());
    if (!root) {
      console.error(cross("Could not find doco.yaml in this directory or any parent."));
      process.exitCode = 2;
      return;
    }
    if (!args["no-reindex"]) {
      await reindex(root);
    }
    const db = await openDb(root, { readonly: true, fileMustExist: true });
    try {
      const report = runAllLints(db, { docoRoot: root });

      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
        if (report.errors > 0) process.exitCode = 1;
        return;
      }

      console.log();
      console.log(header(`Lint report  ${c.dim(`(${root})`)}`));
      console.log(rule());
      for (const [name, issues] of Object.entries(report.issuesByLint)) {
        const status = issues.length === 0 ? c.ok("clean") : c.err(`${issues.length} issue(s)`);
        console.log(`  ${name.padEnd(20)} ${status}`);
      }
      console.log(rule());
      if (report.total === 0) {
        console.log(checkmark("All lints clean."));
        console.log();
        return;
      }
      console.log(`${c.err(String(report.errors))} errors, ${c.warn(String(report.warnings))} warnings`);
      console.log();
      for (const issue of report.issues) {
        const sigil = issue.severity === "error" ? c.err("✗") : c.warn("!");
        console.log(`${sigil} ${c.bold(issue.lintId.padEnd(20))} ${c.dim(issue.source)}`);
        console.log(`    ${issue.message}`);
      }
      console.log();
      if (report.errors > 0) process.exitCode = 1;
    } finally {
      db.close();
    }
  },
});
