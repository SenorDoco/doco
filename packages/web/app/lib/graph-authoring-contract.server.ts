import { BLOCKED_NODE_JSON_EDGE_FIELD_SET } from "@doco/shared";
import type { AttachedPerspective } from "~/lib/perspectives.server";

export type RelationOwner = "from" | "to";
export type RelationCardinality = "one" | "many";

export interface RelationKindSpec {
  kind: string;
  storage: "edge";
  owner: RelationOwner;
  value: RelationOwner;
  cardinality: RelationCardinality;
  acceptsProps?: string[];
  role_examples?: string[];
  description: string;
}

export const RELATION_KINDS: Record<string, RelationKindSpec> = {
  flows_to: {
    kind: "flows_to",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    acceptsProps: ["label", "condition", "kind"],
    description: "Forward ordered flow between process nodes.",
  },
  supports: {
    kind: "supports",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    role_examples: ["serves", "enacts", "tests", "implemented_by"],
    description:
      "Broad enabling relation, optionally role-tagged as serves, enacts, tests, or implemented_by.",
  },
  constrained_by: {
    kind: "constrained_by",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    role_examples: ["gated_by", "consults"],
    description: "Node is constrained by Rules, optionally role-tagged as gated_by or consults.",
  },
  attributed_to: {
    kind: "attributed_to",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    role_examples: ["performed_by", "owned_by", "decided_by"],
    description: "Principal attribution for performers, owners, stakeholders, and decision makers.",
  },
  has_parent: {
    kind: "has_parent",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    role_examples: ["parent_intent", "reports_to", "dotted_reports_to"],
    description: "Hierarchy relation for Intent nesting and Principal reporting lines.",
  },
  derived_from: {
    kind: "derived_from",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "many",
    description: "Provenance relation for source material and templates.",
  },
  replaces: {
    kind: "replaces",
    storage: "edge",
    owner: "from",
    value: "to",
    cardinality: "one",
    description: "Replacement or supersession relation.",
  },
  relates_to: {
    kind: "relates_to",
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
      "Use flows_to for ordered flow.",
      "Use supports role=serves for Intent pool membership.",
      "Use attributed_to role=performed_by for actor lanes and role=owned_by for process ownership.",
      "Use constrained_by role=gated_by for policy guards.",
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
      "Every active non-root Principal should have exactly one has_parent edge with role=reports_to.",
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
      "Keep one concept per Decision; record aliases, synonyms, and rejected labels in `alternatives`.",
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

export function unsupportedNodeJsonEdgeKeyError(
  _entityType: string,
  body: Record<string, unknown>,
): string | null {
  for (const field of BLOCKED_NODE_JSON_EDGE_FIELD_SET) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    return `${field} is not a node JSON field. Create, update, or retire a first-class edge instead.`;
  }
  return null;
}
