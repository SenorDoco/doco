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
  /** Display label for the Principal. */
  name: string;
  /** Optional one-line description; rendered under the label. */
  description: string | null;
  /**
   * "person" | "agent" — drives the icon (👤 vs 🤖). Inferred from
   * `body_md` prose, not from a structured field (the slim-down
   * removed `type` from the Principal data shape). null = no
   * confident inference; the perspective omits the icon for those.
   */
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
  lifecycle: string | null;
  body_md: string | null;
  data: Record<string, unknown>;
}

/**
 * Infer person-vs-agent from the Principal's prose. Cheap regex scan —
 * the canonical phrases the org-chart guidance suggests ("AI agent",
 * "Operates under:", "Autonomous agent", "Human director", "Person",
 * etc.) light up the right bucket. When the prose is silent or
 * mixes signals the function returns null so the perspective omits
 * the icon — better than guessing wrong.
 */
function inferKindFromProse(body: string | null): "person" | "agent" | null {
  if (!body) return null;
  const text = body.toLowerCase();
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

export async function loadOrgTreeData(
  c: QueryClient,
  docoId: string,
  handle: string,
): Promise<OrgTreeData> {
  const rows = (
    await c.query<OrgTreeRow>(
      // Migration 037 dropped `summary` from principals; the
      // description shown under the label is now the first non-blank
      // line of `body_md`.
      `SELECT id, name, COALESCE(lifecycle, 'active') AS lifecycle, body_md, data
         FROM principals
        WHERE doco_id = $1
        ORDER BY created_at`,
      [docoId],
    )
  ).rows;

  const nodes: OrgTreeNode[] = rows.map((r) => {
    const data = r.data ?? {};
    // Description: first non-blank line of body_md, when it isn't just
    // a repetition of the name label.
    const nameNorm = r.name.toLowerCase();
    let description: string | null = null;
    if (r.body_md) {
      const firstLine = r.body_md
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (firstLine && firstLine.toLowerCase() !== nameNorm) {
        description = firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
      }
    }
    const type = inferKindFromProse(r.body_md);
    const reports_to = typeof data.reports_to === "string" ? data.reports_to : null;
    return {
      id: r.id,
      name: r.name,
      description,
      type,
      lifecycle: r.lifecycle ?? "active",
      reports_to,
      href: `/${handle}/principal/${r.id}`,
    };
  });

  return { nodes };
}
