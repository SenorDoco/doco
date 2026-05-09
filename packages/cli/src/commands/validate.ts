import { defineCommand } from "citty";
import { SchemaValidator, loadEvalo, validateEvalo } from "@evalo/core";
import { findEvaloRoot } from "../find-root.js";
import { bullet, c, checkmark, cross, header, rule } from "../output.js";

export const validateCmd = defineCommand({
  meta: {
    name: "validate",
    description: "Validate every entity in the current Evalo against schema and cross-references.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Emit a JSON report instead of human-readable output.",
      default: false,
    },
    root: {
      type: "string",
      description: "Path to the Evalo root (default: walk upward from cwd).",
    },
  },
  async run({ args }) {
    const rootArg = (args.root as string | undefined) ?? undefined;
    const root = rootArg ?? (await findEvaloRoot());
    if (!root) {
      console.error(cross("Could not find evalo.yaml in this directory or any parent."));
      process.exitCode = 2;
      return;
    }

    const loaded = await loadEvalo(root);
    const validator = await SchemaValidator.load(root);
    const report = await validateEvalo(loaded, validator);

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
      return;
    }

    console.log();
    console.log(header(`Evalo: ${loaded.evalo.slug}  ${c.dim(`(${root})`)}`));
    console.log(rule());
    console.log(bullet(`Total entities: ${c.bold(String(report.totalEntities))}`));
    for (const [type, count] of Object.entries(report.entitiesByType)) {
      if (count > 0) console.log(`  ${c.dim("·")} ${type}: ${count}`);
    }
    console.log(rule());

    if (report.ok) {
      console.log(checkmark(`All entities valid.`));
      console.log();
      return;
    }

    console.log(cross(`${report.issues.length} issue(s) found:`));
    console.log(`  schema errors:  ${c.err(String(report.schemaErrors))}`);
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
