/**
 * Orchestrator for the authoring-policies evaluator. Loads the
 * inputs the engine needs from Postgres, calls the pure evaluator
 * from `@doco/shared`, and returns categorized violations.
 *
 * Replaces the pre-v16 `runScopeRules` orchestrator (deleted in
 * commit 4974339) — see capture.server.ts:544-547 for the tombstone.
 * The replacement is simpler because v16 dropped scopes: policies
 * apply to the whole doco, no `gated_by` traversal, no parent-scope
 * inheritance, no `excluded_rules` opt-out.
 */

import { type PoolClient, withClient } from "@doco/db";
import { NODE_TABLES } from "@doco/db";
import {
  type CandidateFields,
  type DeterministicSubKind,
  type EdgeCandidate,
  type EngineEdge,
  type Lifecycle,
  type LoadedPolicy,
  type PolicyKind,
  type PrincipalIndex,
  type Violation,
  agentInstructionOf,
  edgePolicyAppliesToEdge,
  evaluateEdgePolicies,
  evaluatePolicies,
  isDeterministicPredicate,
  policyFiresFor,
} from "@doco/shared";
import { judgeProbabilisticPredicate } from "./llm-judge.server";

/** The deterministic `sub_kind` of a policy, or null for suggestion/probabilistic. */
function subKindOf(p: LoadedPolicy): DeterministicSubKind | null {
  return isDeterministicPredicate(p.predicate) ? p.predicate.sub_kind : null;
}

/**
 * Deterministic sub-kinds that assert a lifecycle-independent invariant — they
 * describe what may exist in the Doco at all, not what an *active* node
 * must look like. These keep firing even on terminal (retired)
 * candidates: a Doco's declared type/membership scope ("only these
 * node types belong here", "this node must not carry X") must hold
 * regardless of lifecycle, otherwise a node captured terminal-by-default
 * (e.g. an Action, which defaults to `retired`) could slip past a
 * template's entity-type allowlist. Every other check is a
 * shape/completeness gate ("an active node of this kind must have field
 * X / edge Y") and is skipped on the way out — see `runAuthoringPolicies`.
 */
const LIFECYCLE_INDEPENDENT_KINDS: ReadonlySet<DeterministicSubKind> = new Set([
  "requires_entity_type",
  "requires_node_type",
  "forbids_edge",
  "forbids_field",
]);

export interface AuthoringResult {
  /** Number of loaded policies that applied to this candidate. */
  evaluated: number;
  /** Number of applicable policies that passed after deterministic + probabilistic checks. */
  passed: number;
  /** Every violation produced by the engine. */
  violations: Violation[];
  /** Convenience: first violation whose `on_violation` is "block", or null. */
  blocking: Violation | null;
  /** Convenience: violations whose `on_violation` is "warn". */
  warnings: Violation[];
}

/**
 * Evaluate the doco's authoring policies against a candidate
 * node / policy. The caller passes the candidate's full
 * frontmatter (as it would be persisted) AFTER any merge with an
 * existing row (for updates).
 *
 * The candidate's outgoing edges are read from the edges table; node JSON is
 * never interpreted as relationship authoring input.
 */
export async function runAuthoringPolicies(opts: {
  docoId: string;
  candidate: CandidateFields;
  /**
   * When provided, every load runs on this client (typically a
   * transaction client opened in capture.server.ts so the enforcer and
   * the upsert see the same DB snapshot). Without it the runner opens
   * its own pooled connection.
   */
  client?: PoolClient;
}): Promise<AuthoringResult> {
  const emptyResult = (): AuthoringResult => ({
    evaluated: 0,
    passed: 0,
    violations: [],
    blocking: null,
    warnings: [],
  });

  // Terminal (retired) candidates skip *content-quality* enforcement.
  // Retire is a winding-down operation: the content was valid when it
  // was active, and gating the transition behind shape/completeness
  // rules would block authors from ever closing out stale nodes — the
  // node already passed those checks on the way in. But type/membership
  // invariants are lifecycle-independent: a Doco's declared scope ("only
  // these node types belong here") must hold even for a node recorded as
  // already retired. Without this, a node that defaults to a terminal
  // lifecycle (Actions/Logs default `retired`) would slip past a
  // template's entity-type allowlist entirely. So on terminal candidates
  // we keep only the LIFECYCLE_INDEPENDENT_KINDS gates and drop the rest.
  const terminal = opts.candidate.lifecycle === "retired";

  const run = async (c: PoolClient): Promise<AuthoringResult> => {
    const policies = await loadPolicies(c, opts.docoId);
    if (policies.length === 0) {
      return emptyResult();
    }
    let applicablePolicies = policies.filter((p) => policyFiresFor(p, opts.candidate));
    if (terminal) {
      applicablePolicies = applicablePolicies.filter((p) => {
        const sk = subKindOf(p);
        return sk !== null && LIFECYCLE_INDEPENDENT_KINDS.has(sk);
      });
    }
    const evaluated = applicablePolicies.length;
    if (evaluated === 0) {
      return emptyResult();
    }

    const populationNodeTypes = collectPopulationNodeTypes(applicablePolicies);
    const needsPrincipals = applicablePolicies.some(
      (p) => subKindOf(p) === "requires_field_resolves_to_principal",
    );
    const needsEdges = applicablePolicies.some((p) => {
      const sk = subKindOf(p);
      return (
        sk === "requires_edge" ||
        sk === "limits_edge" ||
        sk === "forbids_edge" ||
        sk === "graph-completeness" ||
        sk === "flow-wiring"
      );
    });
    const needsPopulation = populationNodeTypes.size > 0;

    // Sequential when sharing a transaction client (pg can't pipeline
    // statements on a single client); the perf cost is a few ms.
    const principals = needsPrincipals
      ? await loadPrincipals(c, opts.docoId)
      : (new Set() as PrincipalIndex);
    const edges = needsEdges ? await loadEdges(c, opts.docoId) : [];
    const candidateEdges = edges.filter((edge) => edge.from_id === opts.candidate.id);
    const population = needsPopulation
      ? await loadPopulation(c, opts.docoId, populationNodeTypes, opts.candidate.id)
      : [];

    const rawViolations = evaluatePolicies({
      candidate: opts.candidate,
      policies: applicablePolicies,
      candidateEdges,
      edges,
      principals,
      population,
    });
    const violations = await resolveProbabilistic(rawViolations, policies, opts.candidate);
    const blocking = violations.find((v) => v.on_violation === "block") ?? null;
    const warnings = violations.filter((v) => v.on_violation === "warn");
    const passed = Math.max(0, evaluated - violations.length);
    return { evaluated, passed, violations, blocking, warnings };
  };

  return opts.client ? run(opts.client) : withClient(run);
}

export interface EdgeAuthoringResult {
  /** Edge-scoped policies that applied to (were evaluated against) this edge. */
  evaluated: number;
  /** How many of those passed — `evaluated` minus the resolved violations. */
  passed: number;
  /** Every violation produced (after judge resolution). */
  violations: Violation[];
  /** First blocking violation, or null. */
  blocking: Violation | null;
  /** Non-blocking warnings. */
  warnings: Violation[];
}

/**
 * Evaluate the doco's edge-scoped probabilistic policies against a
 * newly-created edge. Unlike `runAuthoringPolicies` (which grades a single
 * node), this fires on the edge and hands the LLM judge BOTH endpoint nodes via
 * `judgeCandidate` — so a policy can compare the two, e.g. that a sub-process
 * child Intent's name is the base form of the calling Action it `serves`.
 *
 * The caller resolves the endpoint node fields and packs them into
 * `judgeCandidate` under keys the policy's spec references (e.g. `action`,
 * `intent`).
 */
export async function runEdgeAuthoringPolicies(opts: {
  docoId: string;
  edge: EdgeCandidate;
  judgeCandidate: Record<string, unknown>;
  /**
   * Include edge-scoped probabilistic quality checks. Pass false for a
   * `drafting` edge — the deterministic `requires_edge_type` allowlist still
   * fires (it's a structural gate), but the LLM quality judges are deferred.
   */
  includeProbabilistic?: boolean;
  client?: PoolClient;
}): Promise<EdgeAuthoringResult> {
  const empty: EdgeAuthoringResult = {
    evaluated: 0,
    passed: 0,
    violations: [],
    blocking: null,
    warnings: [],
  };
  const run = async (c: PoolClient): Promise<EdgeAuthoringResult> => {
    const policies = await loadPolicies(c, opts.docoId);
    if (policies.length === 0) return empty;
    const includeProbabilistic = opts.includeProbabilistic ?? true;
    // Count every applicable policy — not just the ones that produced a
    // violation — so a clean edge still reports "N authoring policies passed".
    const evaluated = policies.filter((p) =>
      edgePolicyAppliesToEdge(p, opts.edge, includeProbabilistic),
    ).length;
    if (evaluated === 0) return empty;
    const raw = evaluateEdgePolicies({ edge: opts.edge, policies, includeProbabilistic });
    const violations = raw.length
      ? await resolveProbabilistic(raw, policies, opts.judgeCandidate)
      : [];
    const blocking = violations.find((v) => v.on_violation === "block") ?? null;
    const warnings = violations.filter((v) => v.on_violation === "warn");
    const passed = Math.max(0, evaluated - violations.length);
    return { evaluated, passed, violations, blocking, warnings };
  };
  return opts.client ? run(opts.client) : withClient(run);
}

/**
 * Resolve `probabilistic` violations by handing the pending spec to an
 * LLM judge. Returned violations have three possible outcomes:
 *
 *   - judge says PASS  → violation dropped from the list
 *   - judge says FAIL  → violation kept, reason replaced with the judge's
 *   - judge UNAVAILABLE → violation forced to "block" with an actionable
 *     error. A policy that can't be evaluated hasn't been satisfied, so we
 *     fail closed and loud (whatever the policy's normal severity) rather
 *     than silently admitting an unvetted node — the blocked capture
 *     surfaces the judge outage immediately, so an operator can spot a
 *     missing key, a rate limit, or an exhausted credit balance.
 *
 * Deterministic violations pass through unchanged. Probabilistic specs
 * are resolved in parallel.
 */
export async function resolveProbabilistic(
  violations: Violation[],
  policies: LoadedPolicy[],
  candidate: Record<string, unknown>,
): Promise<Violation[]> {
  const policyById = new Map(
    policies.map((p) => [p.policy_id, agentInstructionOf(p.predicate) ?? ""]),
  );
  return (
    await Promise.all(
      violations.map(async (v) => {
        if (v.kind !== "probabilistic" || !v.pending_spec) {
          return v;
        }
        const judgment = await judgeProbabilisticPredicate(v.pending_spec, candidate);
        if (judgment === null) {
          // LLM unavailable — the policy could NOT be checked. Fail closed:
          // block the capture (whatever the policy's normal severity) and
          // surface an actionable error so the judge outage is obvious
          // instead of silently admitting an unvetted node. The specific
          // Anthropic error is in the server logs (`[authoring-judge] …`).
          const policyText = policyById.get(v.policy_id) ?? "";
          const detail =
            "the LLM policy judge is unavailable — check the Anthropic API key, rate limits, and credit balance (see server logs for the underlying error)";
          return {
            ...v,
            on_violation: "block" as const,
            reason: policyText
              ? `${policyText} — could not be checked: ${detail}`
              : `policy could not be checked: ${detail}`,
          };
        }
        if (judgment.ok) {
          return null; // Filtered out below.
        }
        const policyText = policyById.get(v.policy_id) ?? "";
        const reason = judgment.reason?.trim() || "judge rejected the candidate";
        return { ...v, reason: policyText ? `${policyText} — ${reason}` : reason };
      }),
    )
  ).filter((v): v is Violation => v !== null);
}

function collectPopulationNodeTypes(policies: LoadedPolicy[]): Set<string> {
  const set = new Set<string>();
  for (const p of policies) {
    const pred = p.predicate;
    if (!isDeterministicPredicate(pred)) continue;
    if (pred.sub_kind === "graph-completeness") {
      set.add(pred.incoming_node_type);
    }
    if (pred.sub_kind === "unique_field") {
      const when = pred.when_node_type;
      if (when && when.length > 0) {
        for (const nodeType of when) set.add(nodeType);
      } else {
        for (const nodeType of Object.keys(NODE_TABLES)) set.add(nodeType);
      }
    }
  }
  return set;
}

type PgClient = Parameters<Parameters<typeof withClient>[0]>[0];

async function loadPolicies(c: PgClient, docoId: string): Promise<LoadedPolicy[]> {
  // COALESCE so a NULL lifecycle column behaves as "active" — the rest of
  // the codebase treats NULL that way (search-filters, doco-stats,
  // full-graph, process-perspective, agent-chat). Without it, a policy
  // whose lifecycle column is NULL is silently invisible to the enforcer
  // while looking accepted everywhere else.
  const r = await c.query<{ id: string; data: Record<string, unknown> | null }>(
    `SELECT id, data
       FROM policies
       WHERE doco_id = $1 AND COALESCE(lifecycle, 'active') = 'active'
         AND data->>'kind' IN ('deterministic', 'probabilistic')`,
    [docoId],
  );
  const out: LoadedPolicy[] = [];
  for (const row of r.rows) {
    const yaml = row.data;
    if (!yaml) {
      console.warn(
        `[authoring-runner] dropping policy ${row.id} from doco ${docoId}: row.data is null`,
      );
      continue;
    }
    const kind = yaml.kind;
    if (kind !== "deterministic" && kind !== "probabilistic") continue;
    const predicate = yaml.predicate;
    if (!predicate || typeof predicate !== "object") {
      console.warn(
        `[authoring-runner] dropping policy ${row.id} from doco ${docoId}: predicate is missing or not an object`,
      );
      continue;
    }
    const onViolation = yaml.on_violation;
    const lifecycleFilter = yaml.fires_when_node_lifecycle;
    out.push({
      policy_id: row.id,
      kind: kind as PolicyKind,
      predicate: predicate as LoadedPolicy["predicate"],
      ...(onViolation === "block" || onViolation === "warn" || onViolation === "log"
        ? { on_violation: onViolation }
        : {}),
      ...(Array.isArray(lifecycleFilter)
        ? {
            fires_when_node_lifecycle: lifecycleFilter.filter(
              (l): l is Lifecycle => typeof l === "string",
            ),
          }
        : {}),
    });
  }
  return out;
}

async function loadPrincipals(c: PgClient, docoId: string): Promise<PrincipalIndex> {
  // Filter to active principals so `requires_field_resolves_to_principal`
  // doesn't accept a retired actor. COALESCE matches the rest of the
  // codebase's NULL-as-active convention.
  const r = await c.query<{ id: string }>(
    "SELECT id FROM nodes WHERE node_type = 'principal' AND doco_id = $1 AND COALESCE(lifecycle, 'active') = 'active'",
    [docoId],
  );
  return new Set(r.rows.map((row) => row.id));
}

async function loadEdges(c: PgClient, docoId: string): Promise<EngineEdge[]> {
  const r = await c.query<{
    from_id: string;
    to_id: string;
    edge_type: string;
  }>(
    "SELECT from_id, to_id, edge_type FROM edges WHERE doco_id = $1 AND COALESCE(lifecycle, 'active') = 'active'",
    [docoId],
  );
  return r.rows;
}

async function loadPopulation(
  c: PgClient,
  docoId: string,
  nodeTypes: Set<string>,
  excludeId: string,
): Promise<CandidateFields[]> {
  if (nodeTypes.size === 0) return [];
  const out: CandidateFields[] = [];
  // Post-collapse: one query over the unified `nodes` table filtered by
  // node_type. Filter to active nodes so a retired covering node doesn't
  // satisfy a `graph-completeness` check — retired = no longer trusted to
  // back a relationship.
  //
  // Slim-down: the catch-all `data` jsonb is gone, so rebuild each population
  // member's field bag from `attributes` (its domain fields, e.g. `chosen`)
  // plus the real columns the evaluator reads off a candidate — `id`,
  // `node_type` (the `unique_field` / completeness `when_node_type` filter),
  // and `lifecycle`.
  const r = await c.query<{
    id: string;
    node_type: string;
    lifecycle: string;
    attributes: Record<string, unknown> | null;
  }>(
    `SELECT id, node_type, COALESCE(lifecycle, 'active') AS lifecycle, attributes FROM nodes
       WHERE doco_id = $1 AND node_type = ANY($2::text[]) AND id <> $3
         AND COALESCE(lifecycle, 'active') = 'active'`,
    [docoId, [...nodeTypes], excludeId],
  );
  for (const row of r.rows) {
    const attrs = row.attributes && typeof row.attributes === "object" ? row.attributes : {};
    out.push({
      ...attrs,
      id: row.id,
      node_type: row.node_type,
      lifecycle: row.lifecycle,
    } as CandidateFields);
  }
  return out;
}
