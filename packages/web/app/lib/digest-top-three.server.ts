// The top three at the head of the activity digest (lib/activity-digest.ts):
// the most important records people and their agents added to a workspace's
// Docos in the digest's period. A score shortlists them: a rule counts more
// than a decision, and a decision more than the rest; replacing an earlier
// record adds to it, and so do the briefs that served it and the records that
// link to it. Claude ranks the shortlist once per workspace and digest and
// writes one sentence on each; each member then gets the first three they may
// read. Without a model, or when its answer can't be used, the score's order
// stands, each record with its first line. Chat Logs, principals and what the
// GitHub import brought are left out: they record the work, not what it taught.

import { type Cadence, type TopItem, digestPeriod, periodLabel } from "./activity-digest";
import { createSenorDocoMessage, getSenorDocoAnthropicApiKey } from "./assistant-runtime.server";
import { summaryOf } from "./brief/brief";

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

/** How many records the model ranks. */
export const SHORTLIST = 15;
export const TOP_THREE_MODEL = "claude-opus-5-5";
/** How long the ranking may take before the score's order stands. */
const RANK_TIMEOUT_MS = 90_000;
/** How much of each record the model reads. */
const PROSE_CHARS = 1200;

/** A record added in the period, with what the score reads. */
export interface Candidate {
  id: string;
  docoId: string;
  docoHandle: string;
  nodeType: string;
  prose: string;
  createdAt: string;
  /** It replaced an earlier record. */
  replaces: boolean;
  /** How many records link to it, or it to them. */
  links: number;
  /** How many briefs served it in the period. */
  served: number;
}

/** What the model says of a record. */
export interface Pick {
  id: string;
  takeaway: string;
}

const TYPE_POINTS: Record<string, number> = { rule: 3, decision: 2 };

function score(c: Candidate): number {
  return (
    (TYPE_POINTS[c.nodeType] ?? 1) +
    (c.replaces ? 2 : 0) +
    Math.log2(1 + c.served) +
    Math.log2(1 + c.links)
  );
}

/** The candidates the model ranks: the highest scores, the newest first among equals. */
export function shortlist(candidates: Candidate[]): Candidate[] {
  return candidates
    .map((c) => ({ c, s: score(c) }))
    .sort((a, b) => b.s - a.s || b.c.createdAt.localeCompare(a.c.createdAt))
    .slice(0, SHORTLIST)
    .map(({ c }) => c);
}

const SYSTEM = `You pick what a team most needs to know from the records added to its shared memory, Doco: the rules it follows, the decisions it made, its ideas, references and the rest.

Rank the records you are given from most to least important to the team as a whole. Lessons, rules and decisions that change how the team works come first; routine or minor records come last. For each one write a takeaway: one plain sentence, under 25 words, that says what was learned or decided, drawn from that record alone and in its language. Use the record's id exactly as given. Rank every record.`;

/** The records, each under its id, type and Doco, for the model to rank. */
export function rankingPrompt(label: string, items: Candidate[]): string {
  const records = items.map((c) => {
    const prose = c.prose.trim();
    const text = prose.length > PROSE_CHARS ? `${prose.slice(0, PROSE_CHARS - 1)}…` : prose;
    return `[${c.id} · ${c.nodeType} · ${c.docoHandle}]\n${text}`;
  });
  return `These records were added in ${label}.\n\n${records.join("\n\n")}`;
}

/** The shortlist in the model's order, with its takeaways, then whatever it
 *  left out; in the score's order with each first line when `picks` is null. */
export function mergeRanking(items: Candidate[], picks: Pick[] | null, baseUrl: string): TopItem[] {
  const base = baseUrl.replace(/\/+$/, "");
  const byId = new Map(items.map((c) => [c.id, c]));
  const ranked: TopItem[] = [];
  const add = (c: Candidate, takeaway: string) => {
    byId.delete(c.id);
    ranked.push({
      id: c.id,
      docoId: c.docoId,
      docoHandle: c.docoHandle,
      takeaway: takeaway.trim() || summaryOf(c.prose),
      url: `${base}/${c.docoHandle}/${c.nodeType}/${c.id}`,
    });
  };
  for (const p of picks ?? []) {
    const c = byId.get(p.id);
    if (c) add(c, p.takeaway);
  }
  for (const c of [...byId.values()]) add(c, "");
  return ranked;
}

const RANKING_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, takeaway: { type: "string" } },
        required: ["id", "takeaway"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
};

/** Claude's ranking of the records in `prompt`, or null when there is no
 *  model or its answer can't be used. */
export async function rankWithModel(prompt: string): Promise<Pick[] | null> {
  if (!getSenorDocoAnthropicApiKey()) return null;
  try {
    const message = await createSenorDocoMessage(
      {
        model: TOP_THREE_MODEL,
        max_tokens: 16000,
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: RANKING_SCHEMA },
        },
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      },
      { signal: AbortSignal.timeout(RANK_TIMEOUT_MS) },
    );
    if (message.stop_reason !== "end_turn") return null;
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const items = (JSON.parse(text) as { items?: unknown }).items;
    if (!Array.isArray(items)) return null;
    const valid = items.every((p) => typeof p?.id === "string" && typeof p?.takeaway === "string");
    return valid ? (items as Pick[]) : null;
  } catch (err) {
    console.warn("[digest-top-three] ranking failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** What was added to the workspace's live Docos in the digest's period. */
export async function loadCandidates(
  c: QueryClient,
  workspaceId: string,
  cadence: Cadence,
  at: Date,
): Promise<Candidate[]> {
  const { since, until } = digestPeriod(cadence, at);
  const { rows } = await c.query<{
    id: string;
    doco_id: string;
    doco_handle: string;
    node_type: string;
    prose: string;
    created_at: Date | string;
    replaces: boolean;
    links: number;
    served: number;
  }>(
    `WITH served AS (
       SELECT s->>'id' AS id, count(*)::int AS n
         FROM query_events q
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(q.metadata->'served') = 'array'
               THEN q.metadata->'served' ELSE '[]'::jsonb END) s
        WHERE q.workspace_id = $1 AND q.at >= $2 AND q.at < $3
        GROUP BY 1
     )
     SELECT n.id, n.doco_id, d.handle AS doco_handle, n.node_type, n.prose, n.created_at,
            EXISTS (SELECT 1 FROM edges e
                     WHERE e.from_id = n.id AND e.edge_type = 'replaces'
                       AND e.lifecycle <> 'retired') AS replaces,
            (SELECT count(*)::int FROM edges e
              WHERE (e.from_id = n.id OR e.to_id = n.id)
                AND e.edge_type <> 'attributed_to' AND e.lifecycle <> 'retired') AS links,
            COALESCE(sv.n, 0) AS served
       FROM nodes n
       JOIN docos d ON d.id = n.doco_id
       LEFT JOIN served sv ON sv.id = n.id
      WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
        AND n.created_at >= $2 AND n.created_at < $3
        AND n.node_type NOT IN ('log', 'principal')
        AND n.lifecycle <> 'retired'
        AND COALESCE(n.locator, '') !~ '^https://github\\.com/[^/]+/[^/]+/(pull|issues)/[0-9]+$'`,
    [workspaceId, since, until],
  );
  return rows.map((r) => ({
    id: r.id,
    docoId: r.doco_id,
    docoHandle: r.doco_handle,
    nodeType: r.node_type,
    prose: r.prose,
    createdAt: new Date(r.created_at).toISOString(),
    replaces: r.replaces,
    links: r.links,
    served: r.served,
  }));
}

/** The workspace's shortlist for the digest sent at `at`, ranked. */
export async function rankTopItems(
  c: QueryClient,
  workspaceId: string,
  cadence: Cadence,
  at: Date,
  baseUrl: string,
  rank: (prompt: string) => Promise<Pick[] | null> = rankWithModel,
): Promise<TopItem[]> {
  const items = shortlist(await loadCandidates(c, workspaceId, cadence, at));
  if (items.length === 0) return [];
  return mergeRanking(items, await rank(rankingPrompt(periodLabel(cadence), items)), baseUrl);
}
