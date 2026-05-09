import { defineCommand } from "citty";
import { openDb, reindex } from "@evalo/index";
import { Glossary, findRules } from "@evalo/discovery";
import { findEvaloRoot } from "../find-root.js";
import { c, cross, header, rule } from "../output.js";

export const findRulesCmd = defineCommand({
  meta: {
    name: "find-rules",
    description:
      "Find Rules relevant to a description, candidate verb/target, or set of tags. 5-strategy retrieval (D-030).",
  },
  args: {
    description: {
      type: "string",
      description: "Free-form description of the work item; FTS + glossary expansion.",
    },
    verb: { type: "string", description: "Action verb (e.g. delete_evalo, edit_file)." },
    target: { type: "string", description: "Target entity id." },
    actor: { type: "string", description: "Actor principal id." },
    tags: { type: "string", description: "Comma-separated tag names." },
    root: { type: "string", description: "Path to the Evalo root." },
    "no-reindex": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
  async run({ args }) {
    const rootArg = (args.root as string | undefined) ?? undefined;
    const root = rootArg ?? (await findEvaloRoot());
    if (!root) {
      console.error(cross("Could not find evalo.yaml in this directory or any parent."));
      process.exitCode = 2;
      return;
    }
    if (!args["no-reindex"]) await reindex(root);

    const db = await openDb(root, { readonly: true, fileMustExist: true });
    const glossary = await Glossary.load(root);
    try {
      const candidate: Record<string, unknown> | undefined = args.verb
        ? {
            node_type: "action",
            verb: args.verb,
            ...(args.target ? { target: args.target } : {}),
            ...(args.actor ? { actor_id: args.actor } : {}),
          }
        : undefined;
      const tags = (args.tags as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

      const result = findRules(db, glossary, {
        ...(args.description !== undefined ? { description: args.description as string } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(candidate !== undefined ? { candidate } : {}),
      });

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log();
      console.log(header(`find-rules`));
      console.log(rule());
      printTier("PRECISE (structural)", result.precise);
      printTier("RELATED (tag overlap)", result.related);
      printTier("POSSIBLY RELEVANT (semantic / FTS)", result.possiblyRelevant);
      console.log();
    } finally {
      db.close();
    }
  },
});

function printTier(title: string, hits: { rule_id: string; rule_slug: string | null; modality: string; phase: string; summary: string; reason?: string }[]): void {
  console.log(c.bold(title));
  if (hits.length === 0) {
    console.log(`  ${c.dim("(no hits)")}`);
    return;
  }
  for (const h of hits) {
    const tag = `[${h.modality}/${h.phase}]`;
    console.log(`  ${c.ok(tag.padEnd(20))} ${h.rule_slug ?? h.rule_id}`);
    console.log(`  ${" ".repeat(20)} ${c.dim(h.summary)}`);
    if (h.reason) console.log(`  ${" ".repeat(20)} ${c.dim(`-- ${h.reason}`)}`);
  }
}
