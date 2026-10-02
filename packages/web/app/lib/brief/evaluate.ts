// Does the brief find what the workspace's own records say mattered? Every
// Log in an Agents chats Doco names the nodes its chat produced or drew on,
// and every pull request is linked (a `supports` edge) to the nodes it
// implements or fixes. Each becomes one query: the Log's or pull request's
// title as `about`, the cited ids as what a good brief serves. Recall,
// precision, nDCG and MRR over them (packages/index retrieval-metrics) score
// the brief; the misses say what it should have found. The same set runs on
// PGlite in the tests and on a database copy with the real models
// (scripts/eval-brief.ts), so a change to the engine is measured, not argued.

import { type QueryEvaluation, type RetrievalReport, evaluateRetrieval } from "@doco/index";
import { DEFAULT_BRIEF_BUDGET } from "./brief";
import { type BriefClient, type BriefDeps, type BriefScope, composeBrief } from "./brief.server";

export interface BriefEvaluationQuery {
  /** The Log or pull request reference the query is drawn from. */
  id: string;
  kind: "log" | "pull_request";
  about: string;
  /** The node ids the record cites: what the brief should serve. */
  relevant: string[];
}

export interface BriefEvaluationResult extends BriefEvaluationQuery {
  served: string[];
  missed: string[];
}

export interface BriefEvaluation {
  report: RetrievalReport;
  results: BriefEvaluationResult[];
}

const NODE_ID =
  /\b(?:intent|idea|rule|decision|action|log|eval|reference|state|principal|policy)_[0-9A-HJKMNP-TV-Z]{26}\b/g;

/** A record's title as an ask: its first line, with the cited ids taken out. */
export function aboutOf(prose: string): string {
  const line = prose.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(NODE_ID, "").replace(/\s+/g, " ").trim();
}

/**
 * The evaluation set the given Docos hold: Logs of Agents chats Docos that
 * cite at least one node other than a Log, and pull request references
 * linked to at least one node, newest first.
 */
export async function loadBriefEvaluationSet(
  c: BriefClient,
  docoIds: string[],
  limit = 200,
): Promise<BriefEvaluationQuery[]> {
  if (docoIds.length === 0) return [];
  const logs = (
    await c.query<{ id: string; prose: string; cited: string[] }>(
      `SELECT l.id, l.prose, array_agg(DISTINCT t.value ORDER BY t.value) AS cited
         FROM nodes l
         JOIN docos d ON d.id = l.doco_id
         JOIN node_touches t ON t.node_id = l.id AND t.kind = 'node'
         JOIN nodes n ON n.id = t.value AND n.doco_id = ANY($1::text[]) AND n.node_type <> 'log'
        WHERE l.doco_id = ANY($1::text[]) AND l.node_type = 'log'
          AND d.data->>'template_handle' = 'agents-chats'
        GROUP BY l.id, l.prose, l.created_at
        ORDER BY l.created_at DESC, l.id
        LIMIT $2`,
      [docoIds, limit],
    )
  ).rows;
  const prs = (
    await c.query<{ id: string; prose: string; cited: string[] }>(
      `SELECT r.id, r.prose, array_agg(DISTINCT e.from_id ORDER BY e.from_id) AS cited
         FROM nodes r
         JOIN edges e ON e.to_id = r.id AND e.edge_type = 'supports' AND e.lifecycle <> 'retired'
         JOIN nodes n ON n.id = e.from_id AND n.doco_id = ANY($1::text[])
        WHERE r.doco_id = ANY($1::text[]) AND r.node_type = 'reference'
          AND r.locator LIKE 'https://github.com/%/pull/%'
        GROUP BY r.id, r.prose, r.created_at
        ORDER BY r.created_at DESC, r.id
        LIMIT $2`,
      [docoIds, limit],
    )
  ).rows;
  return [
    ...logs.map((row) => ({
      id: row.id,
      kind: "log" as const,
      about: aboutOf(row.prose),
      relevant: row.cited,
    })),
    ...prs.map((row) => ({
      id: row.id,
      kind: "pull_request" as const,
      about: aboutOf(row.prose),
      relevant: row.cited,
    })),
  ].filter((q) => q.about !== "" && q.relevant.length > 0);
}

/**
 * Brief each query and score what came back. The record a query is drawn
 * from is hidden from the brief (`exclude`): it is the answer key, and its
 * edges would hand the brief the answers. The synthesis is off, since it
 * changes no ranking; the budget is wide so the cutoffs, not the budget,
 * decide what counts.
 */
export async function evaluateBriefs(
  c: BriefClient,
  scope: BriefScope,
  set: BriefEvaluationQuery[],
  deps: BriefDeps,
  options: { ks?: number[]; budget?: number; rerank?: boolean } = {},
): Promise<BriefEvaluation> {
  const ks = options.ks ?? [1, 5, 10];
  const results: BriefEvaluationResult[] = [];
  const evals: QueryEvaluation[] = [];
  for (const query of set) {
    const brief = await composeBrief(
      c,
      scope,
      {
        about: query.about,
        budget: options.budget ?? DEFAULT_BRIEF_BUDGET * 5,
        rerank: options.rerank ?? true,
        synthesize: false,
        exclude: [query.id],
      },
      deps,
    );
    const served = brief.items.map((item) => item.id);
    const relevance = new Set(query.relevant);
    evals.push({ query: query.about, ranked: served, relevance });
    results.push({
      ...query,
      served,
      missed: query.relevant.filter((id) => !served.includes(id)),
    });
  }
  return { report: evaluateRetrieval(evals, ks), results };
}
