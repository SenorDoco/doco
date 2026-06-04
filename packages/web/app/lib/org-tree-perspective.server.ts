// Org-tree perspective data loader.
//
// Renders a Doco's Principal nodes as a top-down reporting tree:
// the unique top-of-chain Principal (no reports_to role edge) at the root,
// direct reports beneath, and so on. Reporting lines are first-class
// `has_parent` edge rows with reports_to / dotted_reports_to role props;
// node JSON stays free of graph relationship keys.
//
// Only the `org-chart` template attaches this perspective by default,
// but any Doco can opt in via the perspectives picker. The loader
// pulls every active Principal regardless of whether `reports_to`
// is set — orphan members (no manager and no reports) still render
// as standalone nodes so the author can wire them up.

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
  body_md: string | null;
  data: Record<string, unknown>;
  /** Scalar-subquery total principals (bigint → string from pg). */
  total_count?: number | string | null;
}

interface OrgTreeEdgeRow {
  from_id: string;
  to_id: string;
  props: Record<string, unknown> | null;
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
 * Infer person / AI-agent / vacant from the Principal's prose. Cheap regex
 * scan — the canonical phrases the org-chart guidance suggests ("AI agent",
 * "Operates under:", "Autonomous agent", "Human director", "Person",
 * "Vacant — budgeted …", etc.) light up the right bucket. When the prose is
 * silent or mixes signals the function returns null so the perspective omits
 * the icon — better than guessing wrong.
 */
function inferKindFromProse(body: string | null): "person" | "agent" | "vacant" | null {
  if (!body) return null;
  const text = body.toLowerCase();
  // Vacant takes precedence: a budgeted-but-unfilled seat reads as vacant even
  // when its prose names the kind of occupant it is waiting for ("Vacant —
  // budgeted Staff Engineer seat …"). We key on explicit vacancy markers, not a
  // bare "budgeted" (a filled seat can own a budget without being open).
  const vacantSignals = [
    /\bvacant\b/,
    /\bunfilled\b/,
    /\bopen (?:seat|role|req|requisition|position|headcount)\b/,
    /\bto be (?:hired|filled)\b/,
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

function roleFromProse(
  body: string | null,
  name: string,
  type: "person" | "agent" | "vacant" | null,
): string | null {
  if (!body) return null;
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine || firstLine.toLowerCase() === name.toLowerCase()) return null;

  // Strip the leading kind marker plus any trailing punctuation (including the
  // em dash the guidance examples use, e.g. "Vacant — budgeted …") so the role
  // label reads as the role, not the kind.
  const withoutKind =
    type === "agent"
      ? firstLine.replace(
          /^(?:ai[\s-]?agent|autonomous\s+(?:agent|bot|role)|agent|bot)\b[\s:.;,—-]*/i,
          "",
        )
      : type === "vacant"
        ? firstLine.replace(/^(?:vacant|unfilled|open)\b[\s:.;,—-]*/i, "")
        : firstLine.replace(/^(?:human|person|people|employee|contractor)\b[\s:.;,—-]*/i, "");
  const role = withoutKind.trim();
  if (!role) return null;
  return role.length > 72 ? `${role.slice(0, 69)}...` : role;
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
      // Migration 037 dropped `summary` from principals; the
      // description shown under the label is now the first non-blank
      // line of `body_md`.
      `SELECT id, prose AS name, COALESCE(lifecycle, 'active') AS lifecycle, kind,
              attributes->>'body_md' AS body_md, data,
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
            `SELECT from_id, to_id, props
               FROM edges
              WHERE doco_id = $1
                AND (from_id = ANY($2::text[]) OR to_id = ANY($2::text[]))
                AND edge_type = 'has_parent'
              ORDER BY created_at, id`,
            [docoId, principalIds],
          )
        ).rows;
  const reportsToByPrincipal = new Map<string, string>();
  for (const edge of edgeRows) {
    // Edge roles are retired: every `has_parent` edge between principals is a
    // (solid) reporting line; the first parent wins so the tree stays a clean
    // hierarchy. Dotted-line / matrix reporting is no longer modeled distinctly.
    if (!reportsToByPrincipal.has(edge.from_id))
      reportsToByPrincipal.set(edge.from_id, edge.to_id);
  }

  const nodes: OrgTreeNode[] = rows.map((r) => {
    const type = mapPrincipalKind(r.kind) ?? inferKindFromProse(r.body_md);
    const role = roleFromProse(r.body_md, r.name, type);
    const reports_to = reportsToByPrincipal.get(r.id) ?? null;
    // Dotted-line / matrix reporting is no longer modeled (edge roles retired).
    const dotted_reports_to: string[] = [];
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
