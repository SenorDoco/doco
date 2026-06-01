import { MANAGED_RELATION_FIELD_SPECS } from "@doco/shared";
import type { AttachedPerspective } from "~/lib/perspectives.server";

export type RelationOwner = "from" | "to";
export type RelationCardinality = "one" | "many";

export interface RelationKindSpec {
  kind: string;
  field: string;
  storage?: "field" | "edge";
  owner: RelationOwner;
  value: RelationOwner;
  cardinality: RelationCardinality;
  acceptsProps?: string[];
  description: string;
  /**
   * Entity types allowed to own this relation's field on create. When set,
   * supplying the field on any other entity type is rejected (rather than
   * silently dropped). Leave unset to skip owner enforcement.
   */
  owners?: readonly string[];
}

export const RELATION_KINDS: Record<string, RelationKindSpec> = {
  flows_to: {
    kind: "flows_to",
    field: "sequence_to",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    acceptsProps: ["label", "condition", "kind"],
    description:
      "Ordered or predecessor flow between process nodes. `sequence_to` and `preceded_by` remain authoring sugar.",
  },
  supports: {
    kind: "supports",
    field: "supports",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    description:
      "Broad enabling relation: serves an Intent, enacts a Decision, tests a target, or is implemented by code references.",
  },
  constrained_by: {
    kind: "constrained_by",
    field: "constrained_by",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Node is constrained by Rules, including gated_by and rules_consulted inputs.",
  },
  attributed_to: {
    kind: "attributed_to",
    field: "attributed_to",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Principal attribution for performers, owners, stakeholders, and decision makers.",
  },
  has_parent: {
    kind: "has_parent",
    field: "has_parent",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Hierarchy relation for Intent nesting and Principal reporting lines.",
  },
  derived_from: {
    kind: "derived_from",
    field: "derived_from",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Provenance relation for born_from and templated_by inputs.",
  },
  replaces: {
    kind: "replaces",
    field: "replaces",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Replacement/supersession relation, including superseded_by authoring input.",
  },
  relates_to: {
    kind: "relates_to",
    field: "relates_to",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    description:
      "Associative 'see also' link between two peer nodes (the SKOS `related` analogue). No hierarchy or direction implied. Glossaries use it to connect related, confusable, parent/child, or homograph terms.",
  },
};

export interface PerspectiveAuthoringContract {
  perspective: string;
  primary_relation?: string;
  node_types: string[];
  lane_relation?: string;
  constraints: string[];
  preferred_operations: string[];
}

export const PERSPECTIVE_CONTRACTS: Record<string, PerspectiveAuthoringContract> = {
  graph: {
    perspective: "graph",
    node_types: [],
    constraints: [],
    preferred_operations: ["create", "relate"],
  },
  list: {
    perspective: "list",
    node_types: [],
    constraints: [],
    preferred_operations: ["create"],
  },
  bpmn: {
    perspective: "bpmn",
    primary_relation: "flows_to",
    node_types: ["state", "action", "decision"],
    lane_relation: "attributed_to",
    constraints: [
      "Use flows_to for ordered flow; do not use predecessor role edges as BPMN control flow.",
      "Create a flow node and its incoming/outgoing sequence relation in the same changeset whenever possible.",
      "Decision flows_to edges should carry label or condition metadata.",
      "Terminal flow nodes have no outgoing flows_to.",
    ],
    preferred_operations: ["append", "relate"],
  },
  "org-tree": {
    perspective: "org-tree",
    primary_relation: "has_parent",
    node_types: ["principal"],
    constraints: [
      "Every active non-root Principal should have exactly one reports_to relation.",
      "Root Principals must be intentional, not accidental missing managers.",
    ],
    preferred_operations: ["create", "relate"],
  },
  sla: {
    perspective: "sla",
    node_types: ["intent", "rule", "eval", "state"],
    constraints: [
      "Rules define the target promise.",
      "Evals test the target promise through tests relations.",
      "States communicate current service health.",
    ],
    preferred_operations: ["create", "relate"],
  },
  glossary: {
    perspective: "glossary",
    node_types: ["decision", "rule", "reference", "eval"],
    constraints: [
      "Each term entry is a Decision: `chosen` is the canonical headword, `question` the concept, and the prose the definition.",
      "Keep one concept per Decision; record aliases and deprecated wording in `alternatives`.",
      "Use Rules for terminology usage policies and References to cite authoritative sources.",
      "Link related, confusable, or homograph terms with `relates_to`; point deprecated terms at their replacement with `replaces`.",
    ],
    preferred_operations: ["create", "relate"],
  },
};

export function contractForAttachedPerspectives(
  attached: AttachedPerspective[],
): PerspectiveAuthoringContract[] {
  return attached
    .map((p) => PERSPECTIVE_CONTRACTS[p.slug] ?? PERSPECTIVE_CONTRACTS[p.kind])
    .filter((contract): contract is PerspectiveAuthoringContract => Boolean(contract));
}

export function relationKindList(): RelationKindSpec[] {
  return Object.values(RELATION_KINDS);
}

export function relationKind(kind: string): RelationKindSpec | null {
  return RELATION_KINDS[kind] ?? null;
}

/**
 * Reject a create body that sets an owner-gated relation field on an
 * entity type that may not own it. Returns an error string naming the
 * field, or null when the body is clean. Pure — safe to unit test and
 * to call before dispatching to a capture function. Closes the
 * silent-drop footgun where, e.g., `target_ref` on a decision was
 * accepted and quietly discarded.
 */
export function unsupportedRelationFieldError(
  entityType: string,
  body: Record<string, unknown>,
): string | null {
  for (const [field, spec] of Object.entries(MANAGED_RELATION_FIELD_SPECS)) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    const owners = "owners" in spec ? spec.owners : undefined;
    if (!owners) continue;
    if (!owners.includes(entityType as never)) {
      return `${field} (the \`${spec.edgeType}\` relation) is only valid on ${owners.join(
        " or ",
      )}, not ${entityType}.`;
    }
  }
  return null;
}
