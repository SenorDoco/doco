// BPMN perspective server-side data loader. Augments the standard
// overview graph with two things the default view doesn't carry:
//
//   1. Lane assignment — three categories:
//
//      a) Actor lanes (one per Principal):
//           Action   → actor_id
//           Decision → decided_by   (Collaborator id post-rename; we
//                                    walk Collaborator → github_login
//                                    → matching Principal name. Falls
//                                    to Unassigned when no Principal
//                                    counterpart exists.)
//           Intent   → actors[0] (first principal if multi-valued)
//         Neurons without a lane-bearing field, or with a value that
//         doesn't resolve, fall into Unassigned.
//
//      b) Milestone band — pinned to the TOP. States live here
//         regardless of who's acting. In BPMN, milestones / phases
//         are an axis perpendicular to the actor swim lanes; the
//         process passes *through* a State rather than someone
//         *performing* it.
//
//      c) Artifacts band — pinned to the BOTTOM. References, Evals,
//         Ideas, and Rules live here. BPMN puts these alongside the
//         flow as data objects / annotations / business-rule tasks,
//         not in the actor swim lanes. The artifacts band is the
//         flat-list approximation until we can lay them out as
//         floating elements with dashed associations (phase 4).
//
//   2. BPMN shape — the visual primitive a neuron renders as:
//        intent                  → circle      (BPMN start event)
//        decision                → diamond     (BPMN gateway)
//        action                  → task        (BPMN rounded-rect task)
//        rule                    → rectangle   (policy box)
//        state                   → milestone   (compact labeled box in
//                                               the milestone band)
//        eval, reference         → document    (BPMN data object)
//        idea                    → rounded     (capsule — distinct
//                                               from Task so an Idea
//                                               doesn't read as a
//                                               flow step)
//
// Lifecycle color from neuron-colors.ts is preserved as an accent on
// each shape — bordered/edge-tinted in the renderer.
//
// Not rendered in BPMN (per BPMN 2.0 + the business-processes template):
//   - Log   — instances, not designs (template guidance: "Process
//             *instances* (recorded runs) live in a separate Doco as
//             Logs; surface them here only via References")

import { ALL_ENTITY_TABLES } from "@doco/db";
import { parse as parseYaml } from "yaml";
import type { OverviewGraphLink } from "~/components/overview-graph";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export type BpmnShape =
  | "circle"
  | "diamond"
  | "rectangle"
  | "document"
  | "rounded"
  | "task"
  | "milestone";

export interface BpmnLane {
  id: string; // principal id, or "__unassigned__"
  label: string; // principal name, or "Unassigned"
}

export interface BpmnNode {
  id: string;
  entity_type: string;
  name: string | null;
  lifecycle: string | null;
  created_at: string | null;
  href: string | null;
  shape: BpmnShape;
  laneId: string;
}

export interface BpmnGraphData {
  lanes: BpmnLane[];
  nodes: BpmnNode[];
  links: OverviewGraphLink[];
}

// Tables included in the BPMN view. Logs (instances) are excluded —
// see the file header.
const BPMN_TABLES: { table: string; entityType: string }[] = [
  { table: "decisions", entityType: "decision" },
  { table: "intents", entityType: "intent" },
  { table: "actions", entityType: "action" },
  { table: "rules", entityType: "rule" },
  { table: "evals", entityType: "eval" },
  { table: "reference_entities", entityType: "reference" },
  { table: "states", entityType: "state" },
  { table: "ideas", entityType: "idea" },
];

const UNASSIGNED_LANE_ID = "__unassigned__";
// Milestone band — pinned to the top of the canvas. States live here.
export const MILESTONE_LANE_ID = "__milestones__";
// Artifacts band — pinned to the bottom. References, Evals, Ideas,
// and Rules live here (BPMN data objects / annotations / business-rule
// tasks, flat-list approximation until phase 4 adds floating layout).
export const ARTIFACTS_LANE_ID = "__artifacts__";

// Non-actor neuron types: assigned by category, not by an actor field.
// State → milestone band; the rest → artifacts band.
const ARTIFACT_TYPES = new Set(["reference", "eval", "idea", "rule"]);

const SHAPE_BY_TYPE: Record<string, BpmnShape> = {
  intent: "circle",
  state: "milestone",
  decision: "diamond",
  action: "task",
  rule: "rectangle",
  eval: "document",
  reference: "document",
  idea: "rounded",
};

export function shapeForEntityType(entityType: string): BpmnShape {
  return SHAPE_BY_TYPE[entityType] ?? "rectangle";
}

interface NeuronRow {
  id: string;
  entity_type: string;
  summary: string | null;
  lifecycle: string | null;
  created_at: string | null;
  data: Record<string, unknown> | null;
}

interface PrincipalRow {
  id: string;
  name: string;
}

interface CollaboratorRow {
  id: string;
  github_login: string | null;
}

interface SynapseRow {
  from_id: string;
  to_id: string;
  synapse_type: string;
}

export async function loadBpmnGraph(
  c: QueryClient,
  docoId: string,
  opts: { handle?: string } = {},
): Promise<BpmnGraphData> {
  const neuronSql = BPMN_TABLES.map((entry) => {
    // Migrated neurons use the type-named column's first line as the
    // "summary" projected here so the BPMN node label fits the lane.
    const tnCol = ALL_ENTITY_TABLES[entry.entityType]?.typeNamedColumn;
    const summarySelect = tnCol ? `split_part(t.${tnCol}, E'\n', 1) AS summary` : "t.summary";
    return `SELECT t.id,
              '${entry.entityType}'::text AS entity_type,
              ${summarySelect},
              COALESCE(t.lifecycle, 'active') AS lifecycle,
              t.created_at::text AS created_at,
              t.data
         FROM ${entry.table} t
        WHERE t.doco_id = $1
          AND COALESCE(t.lifecycle, 'active') <> 'retired'`;
  }).join(" UNION ALL ");

  const [neuronRows, principalRows, collaboratorRows] = await Promise.all([
    c.query<NeuronRow>(neuronSql, [docoId]),
    // Principals are Doco-scoped (migration 020); filter by the typed
    // column and drop retired role-personas.
    c.query<PrincipalRow>(
      `SELECT id, name
         FROM principals
        WHERE doco_id = $1
          AND COALESCE(lifecycle, 'active') = 'active'`,
      [docoId],
    ),
    // Collaborators who are members of this Doco. Decision.decided_by
    // references a Collaborator (post-rename split); we translate that
    // id to the Collaborator's github_login so the existing
    // principal-by-name match can find an owning Principal.
    c.query<CollaboratorRow>(
      `SELECT c.id, c.github_login
         FROM collaborators c
         JOIN doco_users du ON du.collaborator_id = c.id
        WHERE du.doco_id = $1
          AND c.github_login IS NOT NULL`,
      [docoId],
    ),
  ]);

  const principalByName = new Map<string, PrincipalRow>();
  const principalById = new Map<string, PrincipalRow>();
  for (const p of principalRows.rows) {
    principalByName.set(p.name.toLowerCase(), p);
    principalById.set(p.id, p);
  }
  const collaboratorById = new Map<string, CollaboratorRow>();
  for (const c of collaboratorRows.rows) {
    collaboratorById.set(c.id, c);
  }

  const lanesById = new Map<string, BpmnLane>();
  const nodes: BpmnNode[] = [];

  for (const row of neuronRows.rows) {
    // Non-actor neuron types bypass actor-lane resolution: States go
    // to the milestone band (top); References/Evals/Ideas/Rules go to
    // the artifacts band (bottom). See the file header.
    let laneId: string;
    if (row.entity_type === "state") {
      laneId = MILESTONE_LANE_ID;
      if (!lanesById.has(MILESTONE_LANE_ID)) {
        lanesById.set(MILESTONE_LANE_ID, { id: MILESTONE_LANE_ID, label: "Milestones" });
      }
    } else if (ARTIFACT_TYPES.has(row.entity_type)) {
      laneId = ARTIFACTS_LANE_ID;
      if (!lanesById.has(ARTIFACTS_LANE_ID)) {
        lanesById.set(ARTIFACTS_LANE_ID, { id: ARTIFACTS_LANE_ID, label: "Artifacts" });
      }
    } else {
      const fields = row.data ?? {};
      const laneRef = laneReferenceFor(row.entity_type, fields, collaboratorById);
      const lane = resolveLane(laneRef, principalById, principalByName);
      if (!lanesById.has(lane.id)) lanesById.set(lane.id, lane);
      laneId = lane.id;
    }
    nodes.push({
      id: row.id,
      entity_type: row.entity_type,
      name: row.summary,
      lifecycle: row.lifecycle,
      created_at: row.created_at,
      href: opts.handle ? `/${opts.handle}/${row.entity_type}/${row.id}` : null,
      shape: shapeForEntityType(row.entity_type),
      laneId,
    });
  }

  // Every Principal gets a lane, even when no neuron is assigned to it
  // yet — gives authors a visible target to drag neurons onto and makes
  // the swimlane structure of the doco explicit at a glance.
  for (const p of principalRows.rows) {
    if (!lanesById.has(p.id)) {
      lanesById.set(p.id, { id: p.id, label: p.name });
    }
  }

  // Synapses: only those whose endpoints are both in this node set.
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const ids = Array.from(nodeIdSet);
  let links: OverviewGraphLink[] = [];
  if (ids.length > 0) {
    const synapseRows = await c.query<SynapseRow>(
      `SELECT from_id, to_id, synapse_type
         FROM synapses
        WHERE doco_id = $1
          AND from_id = ANY($2::text[])
          AND to_id   = ANY($2::text[])
        LIMIT 5000`,
      [docoId, ids],
    );
    links = synapseRows.rows.map((r) => ({
      source: r.from_id,
      target: r.to_id,
      synapse_type: r.synapse_type,
    }));
  }

  // Lane order:
  //   1. Milestone band (if present) — top, so phases read above the
  //      work that crosses them.
  //   2. Principal lanes — alphabetical for stable ordering.
  //   3. Artifacts band (if present) — bottom-most of the work area,
  //      below the actor lanes so the artifact cluster reads as
  //      "alongside the flow" rather than "another actor".
  //   4. Unassigned lane (if present) — very bottom; catchall for
  //      actor-type neurons whose actor didn't resolve.
  const lanes: BpmnLane[] = [];
  if (lanesById.has(MILESTONE_LANE_ID)) {
    lanes.push(lanesById.get(MILESTONE_LANE_ID) as BpmnLane);
  }
  const principalLanes: BpmnLane[] = [];
  for (const lane of lanesById.values()) {
    if (
      lane.id !== MILESTONE_LANE_ID &&
      lane.id !== ARTIFACTS_LANE_ID &&
      lane.id !== UNASSIGNED_LANE_ID
    ) {
      principalLanes.push(lane);
    }
  }
  principalLanes.sort((a, b) => a.label.localeCompare(b.label));
  lanes.push(...principalLanes);
  if (lanesById.has(ARTIFACTS_LANE_ID)) {
    lanes.push(lanesById.get(ARTIFACTS_LANE_ID) as BpmnLane);
  }
  if (lanesById.has(UNASSIGNED_LANE_ID)) {
    lanes.push(lanesById.get(UNASSIGNED_LANE_ID) as BpmnLane);
  }

  return { lanes, nodes, links };
}

function parseRawYaml(rawYaml: string | null): Record<string, unknown> {
  if (!rawYaml) return {};
  try {
    const parsed = parseYaml(rawYaml);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fallthrough
  }
  return {};
}

/**
 * The field on this neuron type that names the responsible principal.
 * Returns a string the lane resolver can match against principals
 * (either a principal id or a bare role name), or null when the
 * neuron has no lane-bearing field or no resolvable value.
 *
 * Decisions are special: `decided_by` is a Collaborator id post-rename
 * (entities.ts:290), not a Principal. We translate via the
 * collaborator map to a github_login, which `resolveLane` then matches
 * against Principal `name`. When the Collaborator has no Principal
 * counterpart, the Decision lands in Unassigned cleanly rather than
 * spawning a per-Collaborator unresolved lane.
 */
function laneReferenceFor(
  entityType: string,
  data: Record<string, unknown>,
  collaboratorById: Map<string, CollaboratorRow>,
): string | null {
  switch (entityType) {
    case "action":
      return firstString(data.actor_id) ?? firstString(data.actor);
    case "decision": {
      const ref = firstString(data.decided_by);
      if (!ref) return null;
      if (ref.startsWith("collaborator_")) {
        const collab = collaboratorById.get(ref);
        return collab?.github_login ?? null;
      }
      return ref;
    }
    case "intent":
      return firstString(data.actors) ?? firstString(data.wanted_by);
    default:
      return null;
  }
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item) return item;
    }
  }
  return null;
}

function resolveLane(
  ref: string | null,
  byId: Map<string, PrincipalRow>,
  byName: Map<string, PrincipalRow>,
): BpmnLane {
  if (!ref) return { id: UNASSIGNED_LANE_ID, label: "Unassigned" };
  // Refs may be either a principal id (principal_<ulid>) or a bare
  // role label depending on how the author wrote them. Try both.
  const byIdMatch = byId.get(ref);
  if (byIdMatch) {
    return { id: byIdMatch.id, label: byIdMatch.name };
  }
  const cleaned = ref.replace(/^principal_/, "").toLowerCase();
  const byNameMatch = byName.get(cleaned);
  if (byNameMatch) {
    return { id: byNameMatch.id, label: byNameMatch.name };
  }
  // Unknown principal — still give it its own lane so the author can
  // see which value is unresolved, rather than dumping into Unassigned.
  return { id: `__unresolved__:${ref}`, label: ref };
}
