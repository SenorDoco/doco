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
  sequence_flow: {
    kind: "sequence_flow",
    field: "sequence_to",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    acceptsProps: ["label", "condition", "kind"],
    description: "Forward ordered flow. Authored as a first-class edge.",
  },
  preceded_by: {
    kind: "preceded_by",
    field: "preceded_by",
    storage: "edge",
    owner: "to",
    value: "from",
    cardinality: "many",
    description:
      "Causal/chronological predecessor. Authored as a first-class edge from the later node to the predecessor.",
  },
  serves: {
    kind: "serves",
    field: "intent_ids",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Node serves an Intent.",
  },
  enacts: {
    kind: "enacts",
    field: "decision_ids",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Node enacts or cites a Decision.",
  },
  gated_by: {
    kind: "gated_by",
    field: "gated_by",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Node is guarded by a Rule.",
  },
  consults: {
    kind: "consults",
    field: "rules_consulted",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Node consulted a Rule.",
  },
  tests: {
    kind: "tests",
    field: "target_ref",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Eval or Reference targets another node.",
    owners: ["eval", "reference"],
  },
  born_from: {
    kind: "born_from",
    field: "born_from",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Node was born from another node.",
  },
  superseded_by: {
    kind: "superseded_by",
    field: "superseded_by",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Node is superseded by another node.",
  },
  implemented_by: {
    kind: "implemented_by",
    field: "implemented_by",
    owner: "from",
    value: "to",
    cardinality: "many",
    // No `owners` constraint: any node can be implemented by code
    // references. Decisions/ADRs are implemented by the PRs that ship
    // them; BPMN Actions are implemented by the code files/locations that
    // run them; Evals can be implemented by test files. Same edge,
    // different reading depending on owner type.
    description:
      "Node is implemented by one or more code-artifact Reference nodes (PRs, commits, files, lines).",
  },
  reports_to: {
    kind: "reports_to",
    field: "reports_to",
    owner: "from",
    value: "to",
    cardinality: "one",
    owners: ["principal"],
    description: "Principal reports to another Principal (primary, solid line).",
  },
  dotted_reports_to: {
    kind: "dotted_reports_to",
    field: "dotted_reports_to",
    owner: "from",
    value: "to",
    cardinality: "many",
    owners: ["principal"],
    description:
      "Principal has a secondary / dotted-line (matrix) manager, layered on top of the single primary `reports_to`.",
  },
  same_occupant_as: {
    kind: "same_occupant_as",
    field: "same_occupant_as",
    owner: "from",
    value: "to",
    cardinality: "many",
    owners: ["principal"],
    description:
      "Seat is filled by the same occupant as another Principal (one person, many seats).",
  },
  performed_by: {
    kind: "performed_by",
    field: "actor_id",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Action or Log is performed by a Principal.",
  },
  owned_by: {
    kind: "owned_by",
    field: "owner_id",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Node is owned by a Principal.",
  },
  has_parent: {
    kind: "has_parent",
    field: "parent_intent_id",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Intent is nested under another Intent.",
  },
  has_stakeholder: {
    kind: "has_stakeholder",
    field: "stakeholders",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Intent has a stakeholder Principal.",
  },
  decided_by: {
    kind: "decided_by",
    field: "decided_by",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Decision was made by a Principal.",
  },
  templated_by: {
    kind: "templated_by",
    field: "template_id",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Log instantiates an Action that serves as its template.",
  },
  relates_to: {
    kind: "relates_to",
    // No node scalar projects this edge — it is authored only as a
    // first-class edge via /api/edges.json, so `field` is a stable label
    // that never appears on a node body (no owner enforcement fires).
    field: "relates_to",
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
    primary_relation: "sequence_flow",
    node_types: ["state", "action", "decision"],
    lane_relation: "performed_by",
    constraints: [
      "Use sequence_flow for ordered flow; do not use preceded_by as BPMN control flow.",
      "Create a flow node and its incoming/outgoing sequence relation in the same changeset whenever possible.",
      "Decision sequence_flow edges should carry label or condition metadata.",
      "Terminal flow nodes have no outgoing sequence_flow.",
    ],
    preferred_operations: ["append", "relate"],
  },
  "org-tree": {
    perspective: "org-tree",
    primary_relation: "reports_to",
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
      "Link related, confusable, or homograph terms with `relates_to`; point deprecated terms at their replacement with `superseded_by`.",
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
  for (const spec of Object.values(RELATION_KINDS)) {
    const value = body[spec.field];
    if (value === undefined || value === null) continue;
    if (spec.storage === "edge") {
      return `${spec.field} (the \`${spec.kind}\` relation) must be authored as an edge, not stored in node JSON. Use a changeset relate operation or the edges API.`;
    }
    if (!spec.owners) continue;
    if (!spec.owners.includes(entityType)) {
      return `${spec.field} (the \`${spec.kind}\` relation) is only valid on ${spec.owners.join(
        " or ",
      )}, not ${entityType}.`;
    }
  }
  return null;
}
