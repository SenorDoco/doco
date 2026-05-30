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
  /** Optional short role label rendered under the name. */
  role: string | null;
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

function roleFromProse(
  body: string | null,
  name: string,
  type: "person" | "agent" | null,
): string | null {
  if (!body) return null;
  const firstLine = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine || firstLine.toLowerCase() === name.toLowerCase()) return null;

  const withoutKind =
    type === "agent"
      ? firstLine.replace(
          /^(?:ai[\s-]?agent|autonomous\s+(?:agent|bot|role)|agent|bot)\b\s*[:.;,-]?\s*/i,
          "",
        )
      : firstLine.replace(/^(?:human|person|people|employee|contractor)\b\s*[:.;,-]?\s*/i, "");
  const role = withoutKind.trim();
  if (!role) return null;
  return role.length > 72 ? `${role.slice(0, 69)}...` : role;
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
      `SELECT id, name, COALESCE(lifecycle, 'asserted') AS lifecycle, body_md, data
         FROM principals
        WHERE doco_id = $1
        ORDER BY created_at`,
      [docoId],
    )
  ).rows;

  const nodes: OrgTreeNode[] = rows.map((r) => {
    const data = r.data ?? {};
    const type = inferKindFromProse(r.body_md);
    const role = roleFromProse(r.body_md, r.name, type);
    const reports_to = typeof data.reports_to === "string" ? data.reports_to : null;
    return {
      id: r.id,
      name: r.name,
      role,
      type,
      lifecycle: r.lifecycle ?? "asserted",
      reports_to,
      href: `/${handle}/principal/${r.id}`,
    };
  });

  return { nodes };
}
