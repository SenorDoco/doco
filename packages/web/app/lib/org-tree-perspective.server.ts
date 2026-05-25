// Org-tree perspective data loader.
//
// Renders a Doco's Principal neurons as a top-down reporting tree:
// the unique top-of-chain Principal (no `reports_to`) at the root,
// direct reports beneath, and so on. Edges come from the
// `reports_to` synapse — derived from each Principal's data field
// by `deriveSynapses` and materialized in the `synapses` table.
//
// Only the `org-chart` template attaches this perspective by default,
// but any Doco can opt in via the perspectives picker. The loader
// pulls every active Principal regardless of whether `reports_to`
// is set — orphan members (no manager and no reports) still render
// as standalone nodes so the author can wire them up.

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface OrgTreeNode {
  id: string;
  /** Lowercase slug — the immutable identity field. */
  name: string;
  /** Pretty-cased label preferred for display; falls back to `name`. */
  display_name: string;
  /** Optional one-line description; rendered under the label. */
  description: string | null;
  /** "person" | "agent" — drives the icon (👤 vs 🤖). null = unset. */
  type: "person" | "agent" | null;
  lifecycle: string;
  /** Manager principal id; null for top-of-chain. */
  reports_to: string | null;
  href: string;
}

export interface OrgTreeData {
  nodes: OrgTreeNode[];
}

interface OrgTreeRow {
  id: string;
  name: string;
  summary: string | null;
  lifecycle: string | null;
  data: Record<string, unknown>;
}

export async function loadOrgTreeData(
  c: QueryClient,
  docoId: string,
  handle: string,
): Promise<OrgTreeData> {
  const rows = (
    await c.query<OrgTreeRow>(
      `SELECT id, name, summary, COALESCE(lifecycle, 'active') AS lifecycle, data
         FROM principals
        WHERE doco_id = $1
        ORDER BY created_at`,
      [docoId],
    )
  ).rows;

  const nodes: OrgTreeNode[] = rows.map((r) => {
    const data = r.data ?? {};
    const displayName =
      typeof data.display_name === "string" && data.display_name.trim().length > 0
        ? data.display_name.trim()
        : r.name;
    const description =
      typeof data.description === "string" && data.description.trim().length > 0
        ? data.description.trim()
        : r.summary && r.summary !== r.name
          ? r.summary
          : null;
    const type =
      data.type === "person" || data.type === "agent" ? (data.type as "person" | "agent") : null;
    const reports_to = typeof data.reports_to === "string" ? data.reports_to : null;
    return {
      id: r.id,
      name: r.name,
      display_name: displayName,
      description,
      type,
      lifecycle: r.lifecycle ?? "active",
      reports_to,
      href: `/${handle}/principal/${r.id}`,
    };
  });

  return { nodes };
}
