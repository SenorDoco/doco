// Org-tree perspective data loader.
//
// Renders a Doco's Principal nodes as a top-down reporting tree: the
// top-of-chain Principals (no `has_parent` to another Principal) at the roots,
// direct reports beneath, and so on. Solid reporting lines are first-class
// `has_parent` edge rows between two principals (the first parent wins, so the
// primary hierarchy stays a clean tree); dotted-line / matrix reporting is a
// `relates_to` edge between two principals — influence without authority —
// which the perspective layers over the tree as dashed edges. Node JSON stays
// free of graph relationship keys.
//
// The `org-chart` template attaches this perspective by default, but any Doco
// can opt in via the perspectives picker. The loader pulls every Principal
// regardless of whether it reports to anyone — orphan seats (no manager and no
// reports) still render as standalone nodes so the author can wire them up.

import type { PerspectiveWindowSelection } from "./perspective-window.server";
import { windowNodeIds } from "./perspective-window.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface OrgTreeNode {
  id: string;
  /** Display label for the Principal. */
  name: string;
  /** Optional short role label rendered under the name. */
  role: string | null;
  /**
   * "person" | "agent" | "vacant" — drives the seat icon (👤 / 🤖 / 🪑).
   * Taken from the promoted `kind` column when set (`human`→person,
   * `agent`→agent); otherwise inferred from the Principal's prose, which
   * also covers `vacant` (no `kind` value of its own). null = no confident
   * signal; the perspective omits the icon for those.
   */
  type: "person" | "agent" | "vacant" | null;
  lifecycle: string;
  /** Manager principal id; null for top-of-chain. */
  reports_to: string | null;
  /**
   * Secondary / dotted-line (matrix) manager principal ids. Rendered as
   * dashed edges layered on top of the primary `reports_to` tree.
   */
  dotted_reports_to: string[];
  href: string;
}

export interface OrgTreeData {
  nodes: OrgTreeNode[];
  /**
   * TRUE total of Principal nodes for this Doco (all lifecycles, matching the
   * query), counted before the page limit. `nodes.length` is the loaded slice;
   * the header reports loaded vs this total.
   */
  totalCount: number;
}

interface OrgTreeRow {
  id: string;
  name: string;
  lifecycle: string | null;
  /** Promoted seat kind — "human" | "agent" (null for vacant/undeclared). */
  kind: string | null;
  data: Record<string, unknown>;
  /** Scalar-subquery total principals (bigint → string from pg). */
  total_count?: number | string | null;
}

interface OrgTreeEdgeRow {
  from_id: string;
  to_id: string;
  /** "has_parent" (solid reporting line) or "relates_to" (dotted / matrix). */
  edge_type: string;
}

interface OrgTreeLoadOptions {
  limit?: number;
  window?: PerspectiveWindowSelection;
}

function normalizeLimit(value: number | null | undefined): number | null {
  if (value == null) return null;
  const limit = Math.floor(value);
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

/**
 * Infer person / AI-agent / vacant from the Principal's `prose` (its name + any
 * vacancy declaration). Cheap regex scan — the canonical phrases the org-chart
 * guidance suggests ("AI agent", "Operates under:", "Autonomous agent", "Human
 * director", "Person", "Vacant — budgeted …", etc.) light up the right bucket.
 * When the prose is silent or mixes signals the function returns null so the
 * perspective omits the icon — better than guessing wrong.
 */
function inferKindFromProse(prose: string | null): "person" | "agent" | "vacant" | null {
  if (!prose) return null;
  const text = prose.toLowerCase();
  // Vacant takes precedence: a budgeted-but-unfilled seat reads as vacant even
  // when its prose names the kind of occupant it is waiting for ("Vacant —
  // budgeted Staff Engineer seat …"). We key on explicit vacancy markers, not a
  // bare "budgeted" (a filled seat can own a budget without being open).
  const vacantSignals = [
    /\bvacant\b/,
    /\bunfilled\b/,
    /\bunstaffed\b/,
    /\bno incumbent\b/,
    /\bopen (?:seat|role|req|requisition|position|headcount)\b/,
    // Reversed phrasing of an open requisition: "req open", "requisition is open".
    /\b(?:req|requisition) (?:is )?open\b/,
    /\bto be (?:hired|filled|staffed|backfilled)\b/,
    // A backfill is an open seat awaiting a replacement.
    /\bback-?fill(?:ing|ed)?\b/,
  ];
  if (vacantSignals.some((rx) => rx.test(text))) return "vacant";
  const agentSignals = [
    /\bai[\s-]?agent\b/,
    /\bautonomous (agent|bot|role)\b/,
    /\boperates under:\s*@/,
    /\bdelegated[_ -]?by\b/,
    /\b(?:triage|research|review|coding|qa|support)[\s-]?(?:bot|agent)\b/,
    /\bbot\b/,
  ];
  const personSignals = [/\bhuman\b/, /\bperson\b/, /\bpeople\b/, /\bemployee\b/, /\bcontractor\b/];
  const hasAgent = agentSignals.some((rx) => rx.test(text));
  const hasPerson = personSignals.some((rx) => rx.test(text));
  if (hasAgent && !hasPerson) return "agent";
  if (hasPerson && !hasAgent) return "person";
  return null;
}

/**
 * Map the promoted `kind` column to the perspective's seat type. Principals
 * declare `human` or `agent`; "vacant" has no `kind` of its own, so it stays a
 * prose inference. Returns null for an unset/unrecognized kind so the caller
 * falls back to `inferKindFromProse`.
 */
function mapPrincipalKind(kind: string | null): "person" | "agent" | null {
  if (kind === "human") return "person";
  if (kind === "agent") return "agent";
  return null;
}

export async function loadOrgTreeData(
  c: QueryClient,
  docoId: string,
  handle: string,
  options: OrgTreeLoadOptions = {},
): Promise<OrgTreeData> {
  const windowIds = windowNodeIds(options.window);
  const limit = normalizeLimit(options.limit);
  const params: unknown[] = [docoId];
  if (windowIds.length > 0) params.push(windowIds);
  else if (limit != null) params.push(limit);
  const rows = (
    await c.query<OrgTreeRow>(
      // A principal's text is its `prose` (its name). The seat kind comes from
      // the promoted `kind` column, falling back to a vacancy/person/agent read
      // of the prose when unset.
      `SELECT id, prose AS name, COALESCE(lifecycle, 'active') AS lifecycle, kind,
              extra AS data,
              (SELECT COUNT(*) FROM nodes
                WHERE node_type = 'principal' AND doco_id = $1) AS total_count
         FROM nodes
        WHERE node_type = 'principal'
          AND doco_id = $1
          ${windowIds.length > 0 ? "AND id = ANY($2::text[])" : ""}
        ORDER BY created_at
        ${windowIds.length === 0 && limit != null ? "LIMIT $2" : ""}`,
      params,
    )
  ).rows;

  const principalIds = rows.map((row) => row.id);
  // Load reporting edges at every lifecycle, including retired. Principals
  // already load at every lifecycle and are filtered client-side, so toggling
  // "Retired" on reveals retired principals — but a retired principal's
  // has_parent edge is itself retired, and excluding retired edges here would
  // leave a revealed retired principal stranded as a disconnected root.
  // layoutOrgTree only draws an edge when both endpoints are visible, so the
  // edge-visibility decision belongs to the client. Mirrors full-graph.server.
  const edgeRows =
    principalIds.length === 0
      ? []
      : (
          await c.query<OrgTreeEdgeRow>(
            // Two reporting relationships ride on edges between principals:
            // `has_parent` is the solid primary line; `relates_to` is the
            // dotted-line / matrix line. Pull both in one query.
            `SELECT from_id, to_id, edge_type
               FROM edges
              WHERE doco_id = $1
                AND (from_id = ANY($2::text[]) OR to_id = ANY($2::text[]))
                AND edge_type IN ('has_parent', 'relates_to')
              ORDER BY created_at, id`,
            [docoId, principalIds],
          )
        ).rows;
  const principalIdSet = new Set(principalIds);
  const reportsToByPrincipal = new Map<string, string>();
  const dottedByPrincipal = new Map<string, string[]>();
  for (const edge of edgeRows) {
    if (edge.edge_type === "has_parent") {
      // Every `has_parent` edge between principals is a solid reporting line;
      // the first parent wins so the primary tree stays a clean hierarchy.
      if (!reportsToByPrincipal.has(edge.from_id))
        reportsToByPrincipal.set(edge.from_id, edge.to_id);
    } else {
      // A `relates_to` edge between TWO principals is a dotted-line / matrix
      // report (from the seat to its secondary manager). A relate to a
      // non-principal (a Reference, say) is an ordinary association, not a
      // reporting line, so both endpoints must be principals in this Doco.
      if (!principalIdSet.has(edge.from_id) || !principalIdSet.has(edge.to_id)) continue;
      const list = dottedByPrincipal.get(edge.from_id);
      if (list) list.push(edge.to_id);
      else dottedByPrincipal.set(edge.from_id, [edge.to_id]);
    }
  }

  const nodes: OrgTreeNode[] = rows.map((r) => {
    const type = mapPrincipalKind(r.kind) ?? inferKindFromProse(r.name);
    // No separate body to derive a role sub-label from — the prose IS the name.
    const role = null;
    const reports_to = reportsToByPrincipal.get(r.id) ?? null;
    // Dotted-line / matrix managers — `relates_to` edges to other principals,
    // minus any that merely duplicate the solid reporting line.
    const dotted_reports_to = (dottedByPrincipal.get(r.id) ?? []).filter((id) => id !== reports_to);
    return {
      id: r.id,
      name: r.name,
      role,
      type,
      lifecycle: r.lifecycle ?? "active",
      reports_to,
      dotted_reports_to,
      href: `/${handle}/principal/${r.id}`,
    };
  });

  const totalCount = Number(rows[0]?.total_count ?? 0);

  return { nodes, totalCount };
}
