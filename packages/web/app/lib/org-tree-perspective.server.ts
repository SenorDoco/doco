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

import { loadNodeLifecycleTotals } from "./lifecycle-totals.server";
import { type LifecycleCounts, lifecycleRenderRank } from "./node-colors";
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
   * TRUE total of Principal nodes for this Doco, broken out per lifecycle and
   * counted before the page limit. `nodes.length` is the loaded slice; the
   * header sums the stages the lifecycle filter shows and reports loaded vs that
   * visible total.
   */
  totalByLifecycle: LifecycleCounts;
}

interface OrgTreeRow {
  id: string;
  name: string;
  lifecycle: string | null;
  /** Promoted seat kind — "human" | "agent" (null for vacant/undeclared). */
  kind: string | null;
  data: Record<string, unknown>;
}

interface OrgTreeEdgeRow {
  from_id: string;
  to_id: string;
  /** "has_parent" (solid reporting line) or "relates_to" (dotted / matrix). */
  edge_type: string;
  /** Edge lifecycle (COALESCEd to "active"); picks the live parent on re-point. */
  lifecycle: string;
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
  const [rowsResult, totalByLifecycle] = await Promise.all([
    c.query<OrgTreeRow>(
      // A principal's text is its `prose` (its name). The seat kind comes from
      // the promoted `kind` column, falling back to a vacancy/person/agent read
      // of the prose when unset.
      `SELECT id, prose AS name, COALESCE(lifecycle, 'active') AS lifecycle, kind,
              extra AS data
         FROM nodes
        WHERE node_type = 'principal'
          AND doco_id = $1
          ${windowIds.length > 0 ? "AND id = ANY($2::text[])" : ""}
        ORDER BY created_at
        ${windowIds.length === 0 && limit != null ? "LIMIT $2" : ""}`,
      params,
    ),
    // Per-lifecycle principal totals — the header counts only the stages it
    // shows, immune to the page LIMIT above.
    loadNodeLifecycleTotals(c, docoId, ["principal"]),
  ]);
  const rows = rowsResult.rows;

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
            // dotted-line / matrix line. Pull both in one query. `lifecycle`
            // rides along so the loader can prefer the live (active) parent
            // when a re-point has left an old retired line beside it.
            `SELECT from_id, to_id, edge_type, COALESCE(lifecycle, 'active') AS lifecycle
               FROM edges
              WHERE doco_id = $1
                AND (from_id = ANY($2::text[]) OR to_id = ANY($2::text[]))
                AND edge_type IN ('has_parent', 'relates_to')
              ORDER BY created_at, id`,
            [docoId, principalIds],
          )
        ).rows;
  const principalIdSet = new Set(principalIds);
  // Best `has_parent` per principal: to_id + the lifecycle rank that won it.
  const reportsToByPrincipal = new Map<string, { to: string; rank: number }>();
  const dottedByPrincipal = new Map<string, string[]>();
  for (const edge of edgeRows) {
    if (edge.edge_type === "has_parent") {
      // A seat can carry several `has_parent` edges — re-pointing a reporting
      // line retires the old edge and adds a new active one (edges are
      // immutable). The primary tree stays a clean hierarchy by keeping ONE
      // parent: the most-live line wins (active over retired), and among edges
      // of equal liveness the first/oldest wins, since they arrive ordered by
      // created_at and we only replace on a strictly better rank.
      const rank = lifecycleRenderRank(edge.lifecycle);
      const current = reportsToByPrincipal.get(edge.from_id);
      if (!current || rank < current.rank)
        reportsToByPrincipal.set(edge.from_id, { to: edge.to_id, rank });
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
    const reports_to = reportsToByPrincipal.get(r.id)?.to ?? null;
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

  return { nodes, totalByLifecycle };
}
