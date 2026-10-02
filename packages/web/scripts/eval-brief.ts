// Score the brief on a workspace's own records (lib/brief/evaluate.ts): each
// Log of its Agents chats Docos and each linked pull request is one query,
// the nodes it cites are what a good brief serves. Runs against a database
// copy (a Neon branch), with the real embedding model and reranker when their
// keys are in the environment; without keys it scores words and touches alone.
//
//   DATABASE_URL=postgres://… OPENAI_API_KEY=… DOCO_RERANK_PROVIDER=cohere COHERE_API_KEY=… \
//     pnpm --filter @doco/web exec tsx scripts/eval-brief.ts --workspace meta-doco
//
// Flags: --workspace <handle> (required), --ks 1,5,10, --budget 20000,
// --rerank off, --limit 200 (queries per kind), --verbose (every miss).

import { closePool, withClient } from "@doco/db";
import { evaluateBriefs, loadBriefEvaluationSet } from "../app/lib/brief/evaluate.js";
import { embedQuery } from "../app/lib/embedding-provider.server.js";

function parseArgs(argv: string[]) {
  const opts = {
    workspace: "",
    ks: [1, 5, 10],
    budget: 20000,
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
  const missed = results.filter((r) => r.missed.length > 0);
  console.log(`\n${missed.length} of ${results.length} queries miss something`);
  for (const r of opts.verbose ? missed : missed.slice(0, 10)) {
    console.log(`- ${r.kind} ${r.id}: "${r.about}" missed ${r.missed.join(", ")}`);
  }
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
