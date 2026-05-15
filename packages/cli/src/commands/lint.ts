import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { reindex } from "@doco/index";
import { withClient } from "@doco/db";
import { runAllLints } from "@doco/lints";
import { findDocoRoot } from "../find-root.js";
import { c, checkmark, cross, header, rule } from "../output.js";

export const lintCmd = defineCommand({
  meta: {
    name: "lint",
    description: "Run all built-in system lints against the index.",
  },
  args: {
    root: { type: "string", description: "Path to the Doco root (default: walk upward from cwd)." },
    "no-reindex": {
      type: "boolean",
      description: "Skip the reindex; query the existing index in place.",
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
    const docoId = readDocoId(root);
    if (!docoId) {
      console.error(cross(`Could not read doco_id from ${join(root, "doco.yaml")}.`));
      process.exitCode = 2;
      return;
    }
    if (!args["no-reindex"]) {
      await reindex(root);
    }

    const report = await withClient((conn) => runAllLints(conn, docoId));

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
    console.log(
      `${c.err(String(report.errors))} errors, ${c.warn(String(report.warnings))} warnings`,
    );
    console.log();
    for (const issue of report.issues) {
      const sigil = issue.severity === "error" ? c.err("✗") : c.warn("!");
      console.log(`${sigil} ${c.bold(issue.lintId.padEnd(20))} ${c.dim(issue.source)}`);
      console.log(`    ${issue.message}`);
    }
    console.log();
    if (report.errors > 0) process.exitCode = 1;
  },
});

function readDocoId(root: string): string | null {
  const path = join(root, "doco.yaml");
  if (!existsSync(path)) return null;
  try {
    const fm = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
    const id = fm.id;
    return typeof id === "string" && id.startsWith("doco_") ? id : null;
  } catch {
    return null;
  }
}
