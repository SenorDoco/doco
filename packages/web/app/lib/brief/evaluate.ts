// Evaluate the final brief Doco delivers, after retrieval, tiering and budget
// fill. Curated gold cases make exact evidence-delivery promises: required
// records arrive, forbidden records do not, standing orders are must-obey,
// ids are unique and the brief fits its budget. Workspace Logs and linked
// pull requests provide a larger, weaker set of historical relevance labels;
// the same runner also reports recall, precision, nDCG and MRR for those.
// PGlite tests gate deterministic cases, while scripts/eval-brief.ts runs the
// workspace-derived set on a database copy with real models when configured.

import { type QueryEvaluation, type RetrievalReport, evaluateRetrieval } from "@doco/index";
import { type Brief, DEFAULT_BRIEF_BUDGET } from "./brief";
import { type BriefClient, type BriefDeps, type BriefScope, composeBrief } from "./brief.server";

export interface BriefEvaluationCase {
  id: string;
  kind: "gold" | "log" | "pull_request";
  about: string;
  touching?: string[];
  target?: string;
  budget?: number;
  /** Every listed record must be delivered to the agent. */
  required: string[];
  /** None of these records may be delivered to the agent. */
  forbidden?: string[];
  /** These records are required and must be delivered in the must-obey tier. */
  mustObey?: string[];
  /** Records hidden from retrieval while evaluating this case. */
  exclude?: string[];
}

export interface EvidenceDeliveryScore {
  passed: boolean;
  requiredMissing: string[];
  forbiddenServed: string[];
  mustObeyViolations: string[];
  duplicateIds: string[];
  budgetExceededBy: number;
}

/** Score the brief the same way an agent experiences it: after tiering and budget fill. */
export function scoreEvidenceDelivery(
  evaluationCase: BriefEvaluationCase,
  brief: Pick<Brief, "budget" | "items" | "tokens_used">,
): EvidenceDeliveryScore {
  const servedCounts = new Map<string, number>();
  for (const item of brief.items) {
    servedCounts.set(item.id, (servedCounts.get(item.id) ?? 0) + 1);
  }
  const served = new Set(servedCounts.keys());
  const required = new Set([...evaluationCase.required, ...(evaluationCase.mustObey ?? [])]);
  const requiredMissing = [...required].filter((id) => !served.has(id));
  const forbiddenServed = [...new Set(evaluationCase.forbidden ?? [])].filter((id) =>
    served.has(id),
  );
  const mustObeyViolations = [...new Set(evaluationCase.mustObey ?? [])].filter(
    (id) => !brief.items.some((item) => item.id === id && item.tier === "must_obey"),
  );
  const duplicateIds = [...servedCounts]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();
  const budgetExceededBy = Math.max(0, brief.tokens_used - brief.budget);
  return {
    passed:
      requiredMissing.length === 0 &&
      forbiddenServed.length === 0 &&
      mustObeyViolations.length === 0 &&
      duplicateIds.length === 0 &&
      budgetExceededBy === 0,
    requiredMissing,
    forbiddenServed,
    mustObeyViolations,
    duplicateIds,
    budgetExceededBy,
  };
}

export interface BriefEvaluationResult extends BriefEvaluationCase, EvidenceDeliveryScore {
  served: string[];
  budget: number;
  tokensUsed: number;
}

export interface BriefEvaluation {
  passed: boolean;
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
): Promise<BriefEvaluationCase[]> {
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
      required: row.cited,
      exclude: [row.id],
    })),
    ...prs.map((row) => ({
      id: row.id,
      kind: "pull_request" as const,
      about: aboutOf(row.prose),
      required: row.cited,
      exclude: [row.id],
    })),
  ].filter((q) => q.about !== "" && q.required.length > 0);
}

/**
 * Brief each case and score what the agent actually receives. Records listed
 * in `exclude` are hidden from every retrieval path; workspace-derived cases
 * use that to hide the Log or pull request that contains their answer key.
 * Synthesis is off because it does not change evidence delivery.
 */
export async function evaluateBriefs(
  c: BriefClient,
  scope: BriefScope,
  set: BriefEvaluationCase[],
  deps: BriefDeps,
  options: { ks?: number[]; budget?: number; rerank?: boolean } = {},
): Promise<BriefEvaluation> {
  const ks = options.ks ?? [1, 5, 10];
  const results: BriefEvaluationResult[] = [];
  const evals: QueryEvaluation[] = [];
  for (const evaluationCase of set) {
    const budget = evaluationCase.budget ?? options.budget ?? DEFAULT_BRIEF_BUDGET;
    const brief = await composeBrief(
      c,
      scope,
      {
        about: evaluationCase.about,
        touching: evaluationCase.touching,
        target: evaluationCase.target,
        budget,
        rerank: options.rerank ?? true,
        synthesize: false,
        exclude: evaluationCase.exclude,
      },
      deps,
    );
    const served = brief.items.map((item) => item.id);
    const relevance = new Set([...evaluationCase.required, ...(evaluationCase.mustObey ?? [])]);
    evals.push({ query: evaluationCase.about, ranked: served, relevance });
    results.push({
      ...evaluationCase,
      served,
      budget: brief.budget,
      tokensUsed: brief.tokens_used,
      ...scoreEvidenceDelivery(evaluationCase, brief),
    });
  }
  return {
    passed: results.every((result) => result.passed),
    report: evaluateRetrieval(evals, ks),
    results,
  };
}
