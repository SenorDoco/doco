import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import type { Action } from "@doco/shared";
import { parseEntityContent } from "@doco/core";
import { openDb, reindex } from "@doco/index";
import { checkAgainstRules } from "@doco/runtime";
import { findDocoRoot } from "../find-root.js";
import { c, checkmark, cross, header, rule } from "../output.js";

export const checkCmd = defineCommand({
  meta: {
    name: "check",
    description:
      "Run pre-/invariant-phase Rules against a draft Action file. Blocks if a `must` Rule fails.",
  },
  args: {
    file: {
      type: "positional",
      description: "Path to a draft Action file (.md or .yaml).",
      required: true,
    },
    root: { type: "string", description: "Path to the Doco root (default: walk upward from cwd)." },
    "no-reindex": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
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

    const filePath = resolve(args.file as string);
    const content = await readFile(filePath, "utf8");
    const format = filePath.endsWith(".yaml") ? "yaml" : "md";
    const parsed = parseEntityContent(content, format);
    const action = parsed.data as unknown as Action;

    const db = await openDb(root, { readonly: true, fileMustExist: true });
    try {
      const report = checkAgainstRules(db, action);

      if (args.json) {
        console.log(JSON.stringify(report, null, 2));
        if (report.blocked) process.exitCode = 1;
        return;
      }

      console.log();
      console.log(header(`Check: ${action.id ?? "(draft)"}`));
      console.log(c.dim(`verb: ${action.verb}  actor: ${action.actor_id ?? "?"}  target: ${action.target ?? "?"}`));
      console.log(rule());
      if (report.results.length === 0) {
        console.log(c.dim("(no Rules applied to this Action)"));
      }
      for (const r of report.results) {
        const sigil =
          r.result === "fail" ? c.err("✗") : r.result === "pass" ? c.ok("✓") : c.warn("·");
        console.log(`${sigil} ${c.bold((r.ruleSlug ?? r.ruleId).padEnd(34))} ${r.modality}/${r.phase}`);
        if (r.reason) console.log(`    ${c.dim(r.reason)}`);
      }
      console.log(rule());
      if (report.blocked) {
        console.log(cross(c.bold("BLOCKED")) + " — at least one must/must_not Rule failed.");
        process.exitCode = 1;
      } else {
        console.log(checkmark("Action passes all applicable Rules."));
      }
      console.log();
    } finally {
      db.close();
    }
  },
});
