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

    const violations = evaluatePrimitives({
      candidate: opts.candidate,
      primitives,
      candidateSynapses,
      synapses,
      principals,
      population,
    });
    const blocking = violations.find((v) => v.on_violation === "block") ?? null;
    const warnings = violations.filter((v) => v.on_violation === "warn");
    return { violations, blocking, warnings };
  });
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

async function loadPrimitives(c: PgClient, docoId: string): Promise<LoadedPrimitive[]> {
  const r = await c.query<{ id: string; summary: string; raw_yaml: string }>(
    `SELECT id, summary, raw_yaml
       FROM neuron_authoring_primitives
       WHERE doco_id = $1 AND lifecycle = 'active'`,
    [docoId],
  );
  const out: LoadedPrimitive[] = [];
  for (const row of r.rows) {
    let yaml: Record<string, unknown>;
    try {
      yaml = JSON.parse(row.raw_yaml) as Record<string, unknown>;
    } catch {
      continue;
    }
    const predicate = yaml.predicate;
    if (!predicate || typeof predicate !== "object") continue;
    const onViolation = yaml.on_violation;
    const lifecycleFilter = yaml.fires_when_neuron_lifecycle;
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
    const r = await c.query<{ id: string; raw_yaml: string }>(
      `SELECT id, raw_yaml FROM ${table} WHERE doco_id = $1 AND id <> $2`,
      [docoId, excludeId],
    );
    for (const row of r.rows) {
      try {
        const fm = JSON.parse(row.raw_yaml) as CandidateFields;
        if (fm && typeof fm === "object") out.push(fm);
      } catch {
        // Skip malformed rows.
      }
    }
  }
  return out;
}
