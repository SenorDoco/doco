import { BLOCKED_NODE_JSON_EDGE_FIELD_SET, RELATION_CATALOG } from "@doco/shared";
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

export const RELATION_KINDS: Record<string, RelationKindSpec> = Object.fromEntries(
  Object.values(RELATION_CATALOG).map((entry) => [
    entry.kind,
    {
      kind: entry.kind,
      storage: "edge",
      owner: entry.owner,
      value: entry.value,
      cardinality: entry.cardinality,
      ...(entry.acceptsProps ? { acceptsProps: [...entry.acceptsProps] } : {}),
      ...(entry.roleExamples ? { role_examples: [...entry.roleExamples] } : {}),
      description: entry.description,
    },
  ]),
);

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
      "Each term entry is a Decision whose prose leads with the term on its first line — that first line is the node's name and the dictionary headword — then a blank line and the definition as the body. `chosen` repeats that same canonical term (the case-folded uniqueness key) and `question` states the concept. Don't open with the definition, or it becomes the node's name. A term is canonical (`active`) or deprecated (`retired`) — there is no draft/queue stage.",
      "Keep one concept per Decision; record aliases, synonyms, and rejected labels in `alternatives`.",
      "Use Rules for terminology usage policies; cite a borrowed or standards-based term's source by linking the term to a Reference with `derived_from`.",
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
