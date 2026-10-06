// Score the final briefs Doco delivers on a workspace's own records
// (lib/brief/evaluate.ts). Each Agents chat Log and linked pull request is one
// organic case; its cited nodes are required evidence. The report applies the
// same delivery contract as CI and also shows standard ranking metrics. Run it
// against a database copy (a Neon branch), with the real embedding model and
// reranker when their keys are available; without keys it scores lexical and
// exact-touch retrieval alone.
//
//   DATABASE_URL=postgres://… OPENAI_API_KEY=… DOCO_RERANK_PROVIDER=cohere COHERE_API_KEY=… \
//     pnpm --filter @doco/web exec tsx scripts/eval-brief.ts --workspace meta-doco
//
// Flags: --workspace <handle> (required), --ks 1,5,10, --budget 4000,
// --rerank off, --limit 200 (queries per kind), --verbose (every failure).

import { closePool, withClient } from "@doco/db";
import { DEFAULT_BRIEF_BUDGET } from "../app/lib/brief/brief.js";
import { evaluateBriefs, loadBriefEvaluationSet } from "../app/lib/brief/evaluate.js";
import { embedQuery } from "../app/lib/embedding-provider.server.js";

function parseArgs(argv: string[]) {
  const opts = {
    workspace: "",
    ks: [1, 5, 10],
    budget: DEFAULT_BRIEF_BUDGET,
    rerank: true,
    limit: 200,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? "";
    if (a === "--workspace") opts.workspace = next();
    else if (a === "--ks") opts.ks = next().split(",").map(Number);
    else if (a === "--budget") opts.budget = Number(next());
    else if (a === "--rerank") opts.rerank = next() !== "off";
    else if (a === "--limit") opts.limit = Number(next());
    else if (a === "--verbose") opts.verbose = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  if (!opts.workspace) {
    console.error("Say which workspace: --workspace <handle>");
    process.exit(1);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const evaluation = await withClient(async (c) => {
    const docoIds = (
      await c.query<{ id: string }>(
        `SELECT id FROM docos
          WHERE deleted_at IS NULL
            AND workspace_id = (SELECT id FROM workspaces WHERE handle = $1)
          ORDER BY handle`,
        [opts.workspace],
      )
    ).rows.map((row) => row.id);
    if (docoIds.length === 0) throw new Error(`No Docos in workspace ${opts.workspace}.`);
    const set = await loadBriefEvaluationSet(c, docoIds, opts.limit);
    console.log(`${set.length} queries from ${docoIds.length} Docos in ${opts.workspace}`);
    return evaluateBriefs(
      c,
      { docoIds, origin: "https://doco.to" },
      set,
      { embed: embedQuery, synthesize: null },
      { ks: opts.ks, budget: opts.budget, rerank: opts.rerank },
    );
  });
  const { report, results } = evaluation;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`\nk        ${report.ks.map((k) => String(k).padStart(8)).join("")}`);
  for (const [name, values] of [
    ["recall", report.recall],
    ["precision", report.precision],
    ["nDCG", report.ndcg],
  ] as const) {
    console.log(
      `${name.padEnd(9)}${report.ks.map((k) => pct(values[k] ?? 0).padStart(8)).join("")}`,
    );
  }
  console.log(`MRR      ${pct(report.mrr).padStart(8)}`);
  const failed = results.filter((result) => !result.passed);
  console.log(`\n${failed.length} of ${results.length} cases fail the evidence-delivery contract`);
  for (const result of opts.verbose ? failed : failed.slice(0, 10)) {
    const reasons = [
      result.requiredMissing.length > 0 ? `missing ${result.requiredMissing.join(", ")}` : null,
      result.forbiddenServed.length > 0
        ? `served forbidden ${result.forbiddenServed.join(", ")}`
        : null,
      result.mustObeyViolations.length > 0
        ? `wrong must-obey tier ${result.mustObeyViolations.join(", ")}`
        : null,
      result.duplicateIds.length > 0 ? `duplicated ${result.duplicateIds.join(", ")}` : null,
      result.budgetExceededBy > 0 ? `${result.budgetExceededBy} tokens over budget` : null,
    ].filter((reason): reason is string => reason !== null);
    console.log(`- ${result.kind} ${result.id}: "${result.about}" — ${reasons.join("; ")}`);
  }
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
