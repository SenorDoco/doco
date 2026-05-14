import { defineCommand } from "citty";
import { validateDoco } from "@doco/core";
import { findDocoRoot } from "../find-root.js";
import { loadDocoFromRoot } from "../load-doco.js";
import { bullet, c, checkmark, cross, header, rule } from "../output.js";

export const validateCmd = defineCommand({
  meta: {
    name: "validate",
    description: "Validate every entity in the current Doco loads + cross-references resolve.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Emit a JSON report instead of readable output.",
      default: false,
    },
    root: {
      type: "string",
      description: "Path to the Doco root (default: walk upward from cwd).",
    },
  },
  async run({ args }) {
    const rootArg = (args.root as string | undefined) ?? undefined;
    const root = rootArg ?? (await findDocoRoot());
    if (!root) {
      console.error(cross("Could not find doco.yaml in this directory or any parent."));
      process.exitCode = 2;
      return;
    }

    const loaded = await loadDocoFromRoot(root);
    const report = await validateDoco(loaded);

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      return;
    }

    console.log();
    console.log(header(`Doco: ${loaded.doco.slug}  ${c.dim(`(${root})`)}`));
    console.log(rule());
    console.log(bullet(`Total entities: ${c.bold(String(report.totalEntities))}`));
    for (const [type, count] of Object.entries(report.entitiesByType)) {
      if (count > 0) console.log(`  ${c.dim("·")} ${type}: ${count}`);
    }
    console.log(rule());

    if (report.ok) {
      console.log(checkmark(`All entities loaded; cross-references resolve.`));
      console.log();
      return;
    }

    console.log(cross(`${report.issues.length} issue(s) found:`));
    console.log(`  orphan refs:    ${c.err(String(report.orphanRefs))}`);
    console.log(`  load failures:  ${c.err(String(report.loadFailures))}`);
    console.log();

    for (const issue of report.issues) {
      const sigil = issue.severity === "error" ? c.err("✗") : c.warn("!");
      const where = issue.filePath ?? String(issue.source);
      console.log(`${sigil} ${c.bold(issue.kind.padEnd(15))} ${c.dim(where)}`);
      console.log(`    ${issue.message}`);
    }
    console.log();
    process.exitCode = 1;
  },
});
