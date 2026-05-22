// Extract synapse-shaped edges from raw_yaml structured fields.
//
// In a well-behaved Doco, every neuron-to-neuron reference (a
// decision's `intent_ids`, an action's `serves`, a state's
// `follows`, an eval's `target_ref`) materializes into the
// `synapses` table at capture time, and the BPMN / Graph loaders
// just SELECT from that table.
//
// In practice the capture path doesn't always run that
// materialization (especially on initial INSERT for certain
// neuron types), so Docos can have rich inter-neuron references
// in their raw_yaml but an empty `synapses` table — which makes
// the graph and BPMN views read as "node soup with no edges."
//
// This helper closes that gap on the read side: it scans each
// neuron's raw_yaml for the canonical reference fields and emits
// `OverviewGraphLink` rows for any that point at another neuron
// in the supplied node-id set. The loader merges these with rows
// from the `synapses` table and dedups by (from, to, type).
//
// Once the capture path is fixed (or a backfill migration runs),
// the synapses table will already contain these edges and the
// dedup keeps things idempotent — so this fallback can stay in
// place safely.

import { parse as parseYaml } from "yaml";
import type { OverviewGraphLink } from "~/components/overview-graph";

/**
 * The structured raw_yaml fields that carry inter-neuron
 * references, with the synapse_type each should materialize as.
 * These mirror the field names used by the business-processes
 * template (and the broader Doco entity model in @doco/shared).
 */
const STRUCTURED_REF_FIELDS: readonly { field: string; synapse_type: string }[] = [
  // Business-process flow & purpose
  { field: "serves", synapse_type: "serves" },
  { field: "follows", synapse_type: "follows" },
  // Decisions ↔ Intents
  { field: "intent_ids", synapse_type: "realizes" },
  // Evals pin a target claim
  { field: "target_ref", synapse_type: "targets" },
  // Rules govern other neurons
  { field: "gated_by", synapse_type: "gated_by" },
  // States transitioning from another state
  { field: "from_state", synapse_type: "transitions_from" },
  // Logs of an action
  { field: "of_action", synapse_type: "instance_of" },
];

interface InlineNeuronRow {
  id: string;
  raw_yaml: string | null;
}

/**
 * Returns synthesized OverviewGraphLink rows for any structured
 * ref in `neurons[*].raw_yaml` whose target is in `nodeIds`. The
 * caller is expected to merge these with synapses-table rows and
 * dedup by the link id (`source-target-type`).
 *
 * `attribution` is always `"doco-auto"` so callers (e.g. the BPMN
 * renderer) can render them with the dashed line style — the
 * convention for non-author-asserted synapses.
 */
export function extractInlineSynapses(
  neurons: readonly InlineNeuronRow[],
  nodeIds: ReadonlySet<string>,
): OverviewGraphLink[] {
  const out: OverviewGraphLink[] = [];
  for (const neuron of neurons) {
    if (!nodeIds.has(neuron.id)) continue;
    const parsed = parseRawYaml(neuron.raw_yaml);
    for (const { field, synapse_type } of STRUCTURED_REF_FIELDS) {
      const value = parsed[field];
      if (value == null) continue;
      const targets = Array.isArray(value) ? value : [value];
      for (const t of targets) {
        if (typeof t !== "string") continue;
        if (!nodeIds.has(t)) continue;
        if (t === neuron.id) continue; // refuse self-loops
        out.push({
          source: neuron.id,
          target: t,
          synapse_type,
          attribution: "doco-auto",
        });
      }
    }
  }
  return out;
}

/**
 * Merge two sets of links, deduping by (source, target,
 * synapse_type). The first argument's links win on duplicates.
 * Use this to combine synapses-table rows (authoritative) with
 * inline fallback rows.
 */
export function mergeUniqueLinks(
  primary: readonly OverviewGraphLink[],
  fallback: readonly OverviewGraphLink[],
): OverviewGraphLink[] {
  const seen = new Set<string>();
  const out: OverviewGraphLink[] = [];
  for (const link of primary) {
    const key = `${link.source}|${link.target}|${link.synapse_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  for (const link of fallback) {
    const key = `${link.source}|${link.target}|${link.synapse_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

function parseRawYaml(rawYaml: string | null): Record<string, unknown> {
  if (!rawYaml) return {};
  try {
    const parsed = parseYaml(rawYaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore — malformed raw_yaml just yields zero edges
  }
  return {};
}
