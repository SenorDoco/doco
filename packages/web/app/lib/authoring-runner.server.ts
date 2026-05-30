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
import { NEURON_TABLES } from "@doco/db";
import { deriveSynapses } from "@doco/index";
import {
  type CandidateFields,
  type EngineSynapse,
  type Lifecycle,
  type LoadedPolicy,
  type PrincipalIndex,
  type Violation,
  evaluatePolicies,
  policyFiresFor,
} from "@doco/shared";
import type { Entity } from "@doco/shared";
import { judgeProbabilisticPredicate } from "./llm-judge.server";

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
 * neuron / policy. The caller passes the candidate's full
 * frontmatter (as it would be persisted) AFTER any merge with an
 * existing row (for updates).
 *
 * The candidate's outgoing synapses are derived from its frontmatter;
 * the doco's existing synapses are loaded from the synapses table for
 * `graph-completeness` checks against other neurons.
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

  // Skip enforcement when the candidate is in a terminal lifecycle.
  // Retire is a winding-down operation: the content was valid when it
  // was active, and gating the transition behind content-quality rules
  // would block authors from ever closing out stale neurons. The
  // structural-validity story is "you can't get here without having
  // passed validation already" — re-validating on the way out adds no
  // safety and a lot of friction.
  if (opts.candidate.lifecycle === "retired") {
    return emptyResult();
  }

  const candidateSynapses = deriveSynapses(opts.candidate as unknown as Entity).map(
    (s): EngineSynapse => ({
      from_id: s.from_id,
      to_id: s.to_id,
      synapse_type: s.synapse_type,
    }),
  );

  const run = async (c: PoolClient): Promise<AuthoringResult> => {
    const policies = await loadPolicies(c, opts.docoId);
    if (policies.length === 0) {
      return emptyResult();
    }
    const applicablePolicies = policies.filter((p) => policyFiresFor(p, opts.candidate));
    const evaluated = applicablePolicies.length;
    if (evaluated === 0) {
      return emptyResult();
    }

    const populationNeuronTypes = collectPopulationNeuronTypes(applicablePolicies);
    const needsPrincipals = applicablePolicies.some(
      (p) => p.predicate.kind === "requires_field_resolves_to_principal",
    );
    const needsGraphCompleteness = applicablePolicies.some(
      (p) => p.predicate.kind === "graph-completeness",
    );
    const needsPopulation = populationNeuronTypes.size > 0;

    // Sequential when sharing a transaction client (pg can't pipeline
    // statements on a single client); the perf cost is a few ms.
    const principals = needsPrincipals
      ? await loadPrincipals(c, opts.docoId)
      : (new Set() as PrincipalIndex);
    const synapses = needsGraphCompleteness ? await loadSynapses(c, opts.docoId) : [];
    const population = needsPopulation
      ? await loadPopulation(c, opts.docoId, populationNeuronTypes, opts.candidate.id)
      : [];

    const rawViolations = evaluatePolicies({
      candidate: opts.candidate,
      policies: applicablePolicies,
      candidateSynapses,
      synapses,
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

/**
 * Resolve `probabilistic` violations by handing the pending spec to an
 * LLM judge. Returned violations have three possible outcomes:
 *
 *   - judge says PASS  → violation dropped from the list
 *   - judge says FAIL  → violation kept, reason replaced with the judge's
 *   - judge unavailable → violation kept but demoted to "warn" so the
 *     LLM being down doesn't take a capture path offline
 *
 * Deterministic violations pass through unchanged. Probabilistic specs
 * are resolved in parallel.
 */
async function resolveProbabilistic(
  violations: Violation[],
  policies: LoadedPolicy[],
  candidate: CandidateFields,
): Promise<Violation[]> {
  const policyById = new Map(policies.map((p) => [p.policy_id, p.policy]));
  return (
    await Promise.all(
      violations.map(async (v) => {
        if (v.predicate_kind !== "probabilistic" || !v.pending_spec) {
          return v;
        }
        const judgment = await judgeProbabilisticPredicate(v.pending_spec, candidate);
        if (judgment === null) {
          // LLM unavailable — demote a block to a warning so a flaky
          // judge can't take captures offline. `warn` and `log` pass
          // through unchanged.
          if (v.on_violation === "block") {
            return { ...v, on_violation: "warn" as const };
          }
          return v;
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

function collectPopulationNeuronTypes(policies: LoadedPolicy[]): Set<string> {
  const set = new Set<string>();
  for (const p of policies) {
    if (p.predicate.kind === "graph-completeness") {
      set.add(p.predicate.incoming_neuron_type);
    }
    if (p.predicate.kind === "unique_field") {
      const when = p.predicate.when_neuron_type;
      if (when && when.length > 0) {
        for (const neuronType of when) set.add(neuronType);
      } else {
        for (const neuronType of Object.keys(NEURON_TABLES)) set.add(neuronType);
      }
    }
  }
  return set;
}

type PgClient = Parameters<Parameters<typeof withClient>[0]>[0];

async function loadPolicies(c: PgClient, docoId: string): Promise<LoadedPolicy[]> {
  // COALESCE so a NULL lifecycle column behaves as "asserted" — the rest of
  // the codebase treats NULL that way (search-filters, doco-stats,
  // full-graph, bpmn-perspective, agent-chat). Without it, a policy
  // whose lifecycle column is NULL (e.g. seeded by a migration or
  // restored from backup) is silently invisible to the enforcer while
  // looking accepted everywhere else.
  const r = await c.query<{ id: string; policy: string; data: Record<string, unknown> | null }>(
    `SELECT id, policy, data
       FROM neuron_authoring_policies
       WHERE doco_id = $1 AND COALESCE(lifecycle, 'asserted') = 'asserted'`,
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
    const predicate = yaml.predicate;
    if (!predicate || typeof predicate !== "object") {
      console.warn(
        `[authoring-runner] dropping policy ${row.id} from doco ${docoId}: predicate is missing or not an object`,
      );
      continue;
    }
    const onViolation = yaml.on_violation;
    const lifecycleFilter = yaml.fires_when_neuron_lifecycle;
    out.push({
      policy_id: row.id,
      policy: row.policy ?? "",
      predicate: predicate as LoadedPolicy["predicate"],
      ...(onViolation === "block" || onViolation === "warn" || onViolation === "log"
        ? { on_violation: onViolation }
        : {}),
      ...(Array.isArray(lifecycleFilter)
        ? {
            fires_when_neuron_lifecycle: lifecycleFilter.filter(
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
    "SELECT id FROM principals WHERE doco_id = $1 AND COALESCE(lifecycle, 'asserted') = 'asserted'",
    [docoId],
  );
  return new Set(r.rows.map((row) => row.id));
}

async function loadSynapses(c: PgClient, docoId: string): Promise<EngineSynapse[]> {
  const r = await c.query<{ from_id: string; to_id: string; synapse_type: string }>(
    "SELECT from_id, to_id, synapse_type FROM synapses WHERE doco_id = $1",
    [docoId],
  );
  return r.rows;
}

async function loadPopulation(
  c: PgClient,
  docoId: string,
  neuronTypes: Set<string>,
  excludeId: string,
): Promise<CandidateFields[]> {
  if (neuronTypes.size === 0) return [];
  const tables = [...neuronTypes].map((nt) => NEURON_TABLES[nt]?.table).filter(Boolean) as string[];
  if (tables.length === 0) return [];
  const out: CandidateFields[] = [];
  for (const table of tables) {
    // Filter to active neurons so a retired covering neuron doesn't
    // satisfy a `graph-completeness` check — retired = no longer trusted
    // to back a relationship.
    const r = await c.query<{ id: string; data: Record<string, unknown> | null }>(
      `SELECT id, data FROM ${table}
         WHERE doco_id = $1 AND id <> $2 AND COALESCE(lifecycle, 'asserted') = 'asserted'`,
      [docoId, excludeId],
    );
    for (const row of r.rows) {
      const fm = row.data as CandidateFields | null;
      if (fm && typeof fm === "object") out.push(fm);
    }
  }
  return out;
}
