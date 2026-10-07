// GET /api/v1/brief.json — the Doco brief: what an agent must know before it
// acts, across every Doco the caller can read (lib/brief). The caller says
// what it is about to do (`about`) and what it touches (`touching`, repeatable
// or comma-separated: paths, URLs, node ids, pull requests); the answer comes
// in four tiers, each item with a reason and an id to cite, inside `budget`
// tokens (default 4,000). `since` moves the "in motion" window, `target` names
// the Doco the agent will write to (its goal and policies then bind),
// `workspace` narrows the Docos to one workspace, `rerank` and `synthesize`
// switch those steps off (`0`, `false`, `off`), and `format=text` returns the
// text rendering alone.
//
// Auth: a signed-in principal (cookie session or OAuth bearer, narrowed to the
// token's workspace boundary) or a project token (the Docos the person who
// made it can read in its workspace). 401 when none resolves. Each brief is one query of the workspace in the query log,
// with the brief's id, what it served and how long each step took.

import { withClient } from "@doco/db";
import { getPublicBaseUrl } from "@doco/shared";
import { waitUntil } from "@vercel/functions";
import { loadAgentDisplayIdentity } from "~/lib/agent-identity.server";
import { DEFAULT_BRIEF_BUDGET, renderBriefText } from "~/lib/brief/brief";
import { type BriefRequest, composeBrief } from "~/lib/brief/brief.server";
import {
  listReadableDocosInWorkspace,
  listVisibleDocoIdsForRequest,
} from "~/lib/doco-access.server";
import { buildBriefDisplay } from "~/lib/indicator-lines";
import { isProjectToken, validateProjectToken } from "~/lib/project-tokens.server";
import { recordQuery } from "~/lib/query-log.server";
import { extractBearer, getCurrentPrincipalAsync } from "~/lib/session.server";

// Embedding, reranking and the synthesis each call a model: past the
// platform's default seconds.
export const config = { maxDuration: 60 };

export interface BriefParams extends BriefRequest {
  touching: string[];
  budget: number;
  since: string | null;
  target: string | null;
  rerank: boolean;
  synthesize: boolean;
  workspace: string | null;
  format: "json" | "text";
}

/** The query string as a brief request. Pure. */
export function parseBriefParams(url: URL): BriefParams {
  const p = url.searchParams;
  const flag = (name: string): boolean => {
    const v = (p.get(name) ?? "").trim().toLowerCase();
    return !["0", "false", "off", "no"].includes(v);
  };
  const budget = Number.parseInt(p.get("budget") ?? "", 10);
  return {
    about: (p.get("about") ?? "").trim(),
    touching: p
      .getAll("touching")
      .flatMap((value) => value.split(/[,\n]/))
      .map((value) => value.trim())
      .filter(Boolean),
    budget: Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BRIEF_BUDGET,
    since: p.get("since")?.trim() || null,
    target: p.get("target")?.trim() || null,
    rerank: flag("rerank"),
    synthesize: flag("synthesize"),
    workspace: p.get("workspace")?.trim() || null,
    format: p.get("format") === "text" ? "text" : "json",
  };
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const params = parseBriefParams(url);

  const bearer = extractBearer(request);
  const projectToken = bearer && isProjectToken(bearer) ? await validateProjectToken(bearer) : null;
  const me = projectToken ? null : await getCurrentPrincipalAsync(request);
  if (!projectToken && !me) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  // A project token reads its workspace as the person who made it.
  let docoIds = projectToken
    ? (
        await listReadableDocosInWorkspace(
          projectToken.workspace_id,
          projectToken.created_by_user_id,
        )
      ).map((d) => d.id)
    : await listVisibleDocoIdsForRequest(request, (me as { id: string }).id);

  const viewer = me ? await loadAgentDisplayIdentity(request) : null;
  const origin = getPublicBaseUrl(request);
  const { brief, workspaceIds } = await withClient(async (c) => {
    if (params.workspace && docoIds.length > 0) {
      docoIds = (
        await c.query<{ id: string }>(
          `SELECT d.id FROM docos d
            WHERE d.id = ANY($1::text[])
              AND (d.workspace_id = $2
                   OR d.workspace_id IN (SELECT id FROM workspaces WHERE handle = $2))`,
          [docoIds, params.workspace],
        )
      ).rows.map((row) => row.id);
    }
    const brief = await composeBrief(c, { docoIds, origin }, params);
    // The brief is one query of the workspaces it drew from, or, when it
    // served nothing, of the workspaces in reach.
    const served = brief.items.flatMap((item) => (item.doco ? [item.doco] : []));
    const rows = (
      await c.query<{ workspace_id: string }>(
        served.length > 0
          ? "SELECT DISTINCT workspace_id FROM docos WHERE handle = ANY($1::text[])"
          : "SELECT DISTINCT workspace_id FROM docos WHERE id = ANY($1::text[])",
        [served.length > 0 ? served : docoIds],
      )
    ).rows;
    return { brief, workspaceIds: rows.map((row) => row.workspace_id) };
  });

  for (const workspaceId of workspaceIds) {
    waitUntil(
      recordQuery(request, { workspaceId, docoId: null }, me?.id ?? null, {
        brief_id: brief.brief_id,
        served: brief.items.map((item) => ({ id: item.id, tier: item.tier })),
        held_back: brief.held_back,
        tokens_used: brief.tokens_used,
        steps: brief.steps,
      }),
    );
  }

  const text = renderBriefText(brief);
  if (params.format === "text") {
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  return Response.json({
    ...brief,
    text,
    display: buildBriefDisplay({
      indicatorPrefix: viewer?.indicator_prefix,
      count: brief.items.length,
      heldBack: brief.held_back,
      durationMs: brief.steps.total ?? 0,
    }),
  });
}
