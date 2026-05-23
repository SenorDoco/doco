/**
 * Orchestrator for the authoring-primitives evaluator. Loads the
 * inputs the engine needs from Postgres, calls the pure evaluator
 * from `@doco/shared`, and returns categorized violations.
 *
 * Replaces the pre-v16 `runScopeRules` orchestrator (deleted in
 * commit 4974339) — see capture.server.ts:544-547 for the tombstone.
 * The replacement is simpler because v16 dropped scopes: primitives
 * apply to the whole doco, no `gated_by` traversal, no parent-scope
 * inheritance, no `excluded_rules` opt-out.
 */

import { withClient } from "@doco/db";
import { NEURON_TABLES } from "@doco/db";
import { deriveSynapses } from "@doco/index";
import {
  type CandidateFields,
  type EngineSynapse,
  type Lifecycle,
  type LoadedPrimitive,
  type PrincipalIndex,
  type Violation,
  evaluatePrimitives,
} from "@doco/shared";
import type { Entity } from "@doco/shared";
import { judgeProbabilisticPredicate } from "./llm-judge.server";

export interface AuthoringResult {
  /** Every violation produced by the engine. */
  violations: Violation[];
  /** Convenience: first violation whose `on_violation` is "block", or null. */
  blocking: Violation | null;
  /** Convenience: violations whose `on_violation` is "warn". */
  warnings: Violation[];
}

/**
 * Evaluate the doco's authoring primitives against a candidate
 * neuron / primitive. The caller passes the candidate's full
 * frontmatter (as it would be persisted) AFTER any merge with an
 * existing row (for updates).
 *
 * The candidate's outgoing synapses are derived from its frontmatter;
 * the doco's existing synapses are loaded from the synapses table for
 * `graph-completeness` checks against other neurons.
 */
export async function runAuthoringPrimitives(opts: {
  docoId: string;
  candidate: CandidateFields;
}): Promise<AuthoringResult> {
  // Skip enforcement when the candidate is in a terminal lifecycle.
  // Retire is a winding-down operation: the content was valid when it
  // was active, and gating the transition behind content-quality rules
  // would block authors from ever closing out stale neurons. The
  // structural-validity story is "you can't get here without having
  // passed validation already" — re-validating on the way out adds no
  // safety and a lot of friction.
  if (opts.candidate.lifecycle === "retired") {
    return { violations: [], blocking: null, warnings: [] };
  }

  const candidateSynapses = deriveSynapses(opts.candidate as unknown as Entity).map(
    (s): EngineSynapse => ({
      from_id: s.from_id,
      to_id: s.to_id,
      synapse_type: s.synapse_type,
    }),
  );

  return withClient(async (c) => {
    const primitives = await loadPrimitives(c, opts.docoId);
    if (primitives.length === 0) {
      return { violations: [], blocking: null, warnings: [] };
    }

    const incomingNeuronTypes = collectIncomingNeuronTypes(primitives);
    const needsPrincipals = primitives.some(
      (p) => p.predicate.kind === "requires_field_resolves_to_principal",
    );
    const needsGraphCompleteness = primitives.some(
      (p) => p.predicate.kind === "graph-completeness",
    );

    const [principals, synapses, population] = await Promise.all([
      needsPrincipals ? loadPrincipals(c) : Promise.resolve<PrincipalIndex>(new Set()),
      needsGraphCompleteness ? loadSynapses(c, opts.docoId) : Promise.resolve<EngineSynapse[]>([]),
      needsGraphCompleteness
        ? loadPopulation(c, opts.docoId, incomingNeuronTypes, opts.candidate.id)
        : Promise.resolve<CandidateFields[]>([]),
    ]);

    const rawViolations = evaluatePrimitives({
      candidate: opts.candidate,
      primitives,
      candidateSynapses,
      synapses,
      principals,
      population,
    });
    const violations = await resolveProbabilistic(rawViolations, primitives, opts.candidate);
    const blocking = violations.find((v) => v.on_violation === "block") ?? null;
    const warnings = violations.filter((v) => v.on_violation === "warn");
    return { violations, blocking, warnings };
  });
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
  primitives: LoadedPrimitive[],
  candidate: CandidateFields,
): Promise<Violation[]> {
  const summaryById = new Map(primitives.map((p) => [p.primitive_id, p.summary]));
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
        const summary = summaryById.get(v.primitive_id) ?? "";
        const reason = judgment.reason?.trim() || "judge rejected the candidate";
        return { ...v, reason: summary ? `${summary} — ${reason}` : reason };
      }),
    )
  ).filter((v): v is Violation => v !== null);
}

function collectIncomingNeuronTypes(primitives: LoadedPrimitive[]): Set<string> {
  const set = new Set<string>();
  for (const p of primitives) {
    if (p.predicate.kind === "graph-completeness") {
      set.add(p.predicate.incoming_neuron_type);
    }
  }
  return set;
}

type PgClient = Parameters<Parameters<typeof withClient>[0]>[0];

/**
 * Normalize legacy predicate keys to their post-rename names.
 *
 * Primitives seeded before the vocab sweep (nodes → neurons, edges →
 * synapses) persisted predicate JSON with `when_node_type`,
 * `target_node_type`, and `incoming_node_type`. The engine reads the
 * post-rename keys (`when_neuron_type`, etc.); when the stored payload
 * carries the old keys, the engine treats them as absent and the
 * filter is silently dropped — so a predicate scoped to `["eval"]`
 * fires against every candidate. Rewrite at read time so old data
 * still gates correctly. Idempotent; the new keys win on conflict.
 */
function normalizePredicateKeys(predicate: unknown): unknown {
  if (!predicate || typeof predicate !== "object") return predicate;
  const p = { ...(predicate as Record<string, unknown>) };
  if (!("when_neuron_type" in p) && "when_node_type" in p) {
    p.when_neuron_type = p.when_node_type;
  }
  if (!("target_neuron_type" in p) && "target_node_type" in p) {
    p.target_neuron_type = p.target_node_type;
  }
  if (!("incoming_neuron_type" in p) && "incoming_node_type" in p) {
    p.incoming_neuron_type = p.incoming_node_type;
  }
  return p;
}

async function loadPrimitives(c: PgClient, docoId: string): Promise<LoadedPrimitive[]> {
  const r = await c.query<{ id: string; summary: string; data: Record<string, unknown> | null }>(
    `SELECT id, summary, data
       FROM neuron_authoring_primitives
       WHERE doco_id = $1 AND lifecycle = 'active'`,
    [docoId],
  );
  const out: LoadedPrimitive[] = [];
  for (const row of r.rows) {
    const yaml = row.data;
    if (!yaml) continue;
    const predicate = normalizePredicateKeys(yaml.predicate);
    if (!predicate || typeof predicate !== "object") continue;
    const onViolation = yaml.on_violation;
    // Honor both the post-rename `fires_when_neuron_lifecycle` and the
    // pre-rename `fires_when_node_lifecycle` — primitives seeded before
    // the vocab sweep persist the old key.
    const lifecycleFilter = yaml.fires_when_neuron_lifecycle ?? yaml.fires_when_node_lifecycle;
    out.push({
      primitive_id: row.id,
      summary: row.summary ?? "",
      predicate: predicate as LoadedPrimitive["predicate"],
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

async function loadPrincipals(c: PgClient): Promise<PrincipalIndex> {
  const r = await c.query<{ id: string }>("SELECT id FROM principals");
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
    const r = await c.query<{ id: string; data: Record<string, unknown> | null }>(
      `SELECT id, data FROM ${table} WHERE doco_id = $1 AND id <> $2`,
      [docoId, excludeId],
    );
    for (const row of r.rows) {
      const fm = row.data as CandidateFields | null;
      if (fm && typeof fm === "object") out.push(fm);
    }
  }
  return out;
}
