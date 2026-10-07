// Standing orders: what always applies in one workspace, loaded once at the
// start of a session (the Doco hook's SessionStart, doco_whoami, the route
// /api/v1/standing-orders.json): the constitution, every active rule, a line
// on what each Doco holds and expects of a writer, and what changed since the
// agent last looked. Whoever can read a Doco of the workspace reads its
// constitution (decision_01M3Z5SXF1VZ4N6DSE5AVVZ41N), as on the workspace page and in
// the brief. Small, a target of under 2,000 tokens, and read fresh: five
// statements on indexed tables cost less than any cache would save.

import { countDocoItems, docoItemFor, findDocoTemplateMeta } from "../doco-templates-meta";
import { IN_MOTION_DAYS, expandedText, summaryOf, tokensOf } from "./brief";
import type { BriefClient } from "./brief.server";

/** Characters of a rule's body the orders carry. */
const RULE_CHARS = 400;
/** Policies named per Doco, and changes listed, before "N more". */
const EXPECTS_MAX = 3;
const CHANGES_MAX = 20;
const PROSE_TYPES = [
  "decision",
  "intent",
  "idea",
  "rule",
  "action",
  "log",
  "eval",
  "state",
  "reference",
];

export interface StandingOrdersScope {
  workspaceId: string;
  origin: string;
  /** The Docos of the workspace the caller may read. */
  docoIds: string[];
}

export interface StandingOrdersRequest {
  /** ISO time the agent last looked; default: IN_MOTION_DAYS ago. */
  since?: string | null;
  now?: () => Date;
}

export interface StandingOrders {
  workspace: { id: string; handle: string; name: string; url: string };
  constitution: string | null;
  rules: { id: string; doco: string; summary: string; text: string; url: string }[];
  docos: {
    handle: string;
    template: string | null;
    label: string;
    items: string;
    goal: string;
    expects: string[];
    url: string;
  }[];
  changes: {
    since: string;
    items: {
      id: string;
      doco: string;
      type: string;
      lifecycle: string;
      summary: string;
      updated_at: string;
      url: string;
    }[];
    more: number;
  };
  warnings: string[];
  tokens: number;
  text: string;
}

/** The standing orders of one workspace, or null when it does not exist. */
export async function composeStandingOrders(
  c: BriefClient,
  scope: StandingOrdersScope,
  request: StandingOrdersRequest = {},
): Promise<StandingOrders | null> {
  const now = request.now ? request.now() : new Date();
  const warnings: string[] = [];
  let since = new Date(now.getTime() - IN_MOTION_DAYS * 86_400_000);
  if (request.since) {
    const parsed = Date.parse(request.since);
    if (Number.isNaN(parsed)) warnings.push(`Ignored since=${request.since}: not a date.`);
    else since = new Date(parsed);
  }

  const workspace = (
    await c.query<{ id: string; handle: string; name: string; constitution: string }>(
      "SELECT id, handle, name, constitution FROM workspaces WHERE id = $1",
      [scope.workspaceId],
    )
  ).rows[0];
  if (!workspace) return null;
  const workspaceUrl = `${scope.origin}/workspaces/${workspace.handle}`;

  const docos = (
    await c.query<{ id: string; handle: string; template: string | null; goal: string }>(
      `SELECT id, handle, data->>'template_handle' AS template, goal FROM docos
        WHERE workspace_id = $1 AND deleted_at IS NULL AND id = ANY($2::text[])
        ORDER BY handle`,
      [scope.workspaceId, scope.docoIds],
    )
  ).rows;
  const docoIds = docos.map((d) => d.id);
  const handleOf = new Map(docos.map((d) => [d.id, d.handle]));
  const nodeUrl = (docoId: string, type: string, id: string) =>
    `${scope.origin}/${handleOf.get(docoId)}/${type}/${id}`;

  const [ruleRows, countRows, policyRows, changeRows] = await Promise.all([
    c.query<{ id: string; doco_id: string; prose: string }>(
      `SELECT id, doco_id, prose FROM nodes
        WHERE doco_id = ANY($1::text[]) AND node_type = 'rule' AND lifecycle = 'active'
        ORDER BY created_at, id`,
      [docoIds],
    ),
    c.query<{ doco_id: string; node_type: string; n: number }>(
      `SELECT doco_id, node_type, count(*)::int AS n FROM nodes
        WHERE doco_id = ANY($1::text[]) AND node_type = ANY($2::text[])
          AND lifecycle <> 'retired'
        GROUP BY doco_id, node_type`,
      [docoIds, PROSE_TYPES],
    ),
    c.query<{ doco_id: string; instruction: string }>(
      `SELECT doco_id, data->'predicate'->>'agent_instruction' AS instruction FROM policies
        WHERE doco_id = ANY($1::text[]) AND COALESCE(lifecycle, 'active') = 'active'
          AND COALESCE(data->'predicate'->>'agent_instruction', '') <> ''
        ORDER BY created_at`,
      [docoIds],
    ),
    c.query<{
      id: string;
      doco_id: string;
      node_type: string;
      lifecycle: string;
      prose: string;
      updated_at: string;
      total: number;
    }>(
      `SELECT id, doco_id, node_type, lifecycle, prose, updated_at, count(*) OVER ()::int AS total
         FROM nodes
        WHERE doco_id = ANY($1::text[]) AND node_type = ANY($2::text[]) AND updated_at >= $3
        ORDER BY updated_at DESC, id
        LIMIT $4`,
      [docoIds, PROSE_TYPES, since.toISOString(), CHANGES_MAX],
    ),
  ]);

  const counts = new Map<string, number>();
  for (const row of countRows.rows) {
    counts.set(`${row.doco_id}:${row.node_type}`, row.n);
    counts.set(`${row.doco_id}:node`, (counts.get(`${row.doco_id}:node`) ?? 0) + row.n);
  }
  const expects = new Map<string, string[]>();
  for (const row of policyRows.rows) {
    const list = expects.get(row.doco_id) ?? [];
    if (list.length < EXPECTS_MAX) list.push(summaryOf(row.instruction));
    expects.set(row.doco_id, list);
  }

  const orders: Omit<StandingOrders, "tokens" | "text"> = {
    workspace: {
      id: workspace.id,
      handle: workspace.handle,
      name: workspace.name,
      url: workspaceUrl,
    },
    constitution: workspace.constitution.trim() ? expandedText(workspace.constitution) : null,
    rules: ruleRows.rows.map((row) => ({
      id: row.id,
      doco: handleOf.get(row.doco_id) as string,
      summary: summaryOf(row.prose),
      text: cut(row.prose, RULE_CHARS),
      url: nodeUrl(row.doco_id, "rule", row.id),
    })),
    docos: docos.map((d) => {
      const item = docoItemFor(d.template);
      const counted =
        item.counts === "import" || item.counts === "process"
          ? null
          : (counts.get(`${d.id}:${item.counts}`) ?? 0);
      return {
        handle: d.handle,
        template: d.template,
        label: d.template ? (findDocoTemplateMeta(d.template)?.label ?? d.template) : "Generic",
        items: counted === null ? "" : countDocoItems(counted, d.template),
        goal: summaryOf(d.goal),
        expects: expects.get(d.id) ?? [],
        url: `${scope.origin}/${d.handle}`,
      };
    }),
    changes: {
      since: since.toISOString(),
      items: changeRows.rows.map((row) => ({
        id: row.id,
        doco: handleOf.get(row.doco_id) as string,
        type: row.node_type,
        lifecycle: row.lifecycle,
        summary: summaryOf(row.prose),
        updated_at: new Date(row.updated_at).toISOString(),
        url: nodeUrl(row.doco_id, row.node_type, row.id),
      })),
      more: Math.max(0, (changeRows.rows[0]?.total ?? 0) - changeRows.rows.length),
    },
    warnings,
  };
  if (!orders.constitution) warnings.push(`Workspace ${workspace.name} has no constitution.`);
  if (orders.rules.length === 0) warnings.push("No active rules in the Docos you can read.");
  const text = renderStandingOrders(orders);
  return { ...orders, tokens: tokensOf(text), text };
}

function cut(text: string, chars: number): string {
  const t = text.trim();
  return t.length > chars ? `${t.slice(0, chars - 1)}…` : t;
}

/** The text an agent reads at session start. */
export function renderStandingOrders(orders: Omit<StandingOrders, "tokens" | "text">): string {
  const out: string[] = [
    `Standing orders for ${orders.workspace.name} (${orders.workspace.handle}) · ${orders.workspace.url}`,
  ];
  if (orders.constitution) out.push("", "## Constitution", orders.constitution);
  if (orders.rules.length > 0) {
    out.push("", "## Rules");
    for (const rule of orders.rules) {
      out.push(`- ${rule.id} (${rule.doco}) — ${rule.summary}`);
      const body = rule.text.split("\n").slice(1).join("\n").trim();
      if (body) out.push(...body.split("\n").map((l) => `  ${l}`));
    }
  }
  if (orders.docos.length > 0) {
    out.push("", "## Docos");
    for (const d of orders.docos) {
      const head = `- ${d.handle} (${d.label}${d.items ? `, ${d.items}` : ""})`;
      const goal = d.goal ? `: ${d.goal}` : "";
      const expects = d.expects.length > 0 ? ` Expects: ${d.expects.join("; ")}` : "";
      out.push(`${head}${goal}${expects}`);
    }
  }
  out.push("", `## Changed since ${orders.changes.since.slice(0, 16).replace("T", " ")} UTC`);
  if (orders.changes.items.length === 0) out.push("Nothing.");
  for (const item of orders.changes.items) {
    out.push(`- ${item.id} (${item.doco} · ${item.lifecycle}) — ${item.summary}`);
  }
  if (orders.changes.more > 0) out.push(`${orders.changes.more} more changed.`);
  if (orders.warnings.length > 0) out.push("", orders.warnings.join(" "));
  return out.join("\n");
}
