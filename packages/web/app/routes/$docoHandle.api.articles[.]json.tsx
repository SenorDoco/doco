// GET/POST /<doco-handle>/api/articles.json — dedicated articles endpoint.
//
// Articles (`guidance_article`, `node_authoring_article`) are not nodes.
// They are constitution metadata and are *only* reachable from this
// endpoint, the agent bootstrap response, or the HTML constitution page.
// The generic /<handle>/api/<type>.json dispatcher refuses article types.
//
// GET  → list every article in the Doco, both kinds, with an
//        `article_type` discriminator.
// POST → capture a new article. Body shape:
//        { "article_type": "guidance" | "node_authoring", ...draft }
//        Where `...draft` follows GuidanceArticleDraft or
//        NodeAuthoringArticleDraft from capture.server.ts.

import { roleAtLeast, withClient } from "@doco/db";
import {
  type GuidanceArticleDraft,
  type NodeAuthoringArticleDraft,
  captureGuidanceArticle,
  captureNodeAuthoringArticle,
} from "~/lib/capture.server";
import {
  type DocoRouteParams,
  getDocoLevelRole,
  loadDocoRouteForRead,
} from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";

interface ArticleRow {
  id: string;
  summary: string;
  lifecycle: string | null;
  body_md: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ArticleListEntry extends ArticleRow {
  article_type: "guidance" | "node_authoring";
  node_type: "guidance_article" | "node_authoring_article";
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams;
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  return withClient(async (c) => {
    const [guidance, nodeAuthoring] = await Promise.all([
      c.query<ArticleRow>(
        `SELECT id, summary, lifecycle, body_md,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM guidance_articles
          WHERE doco_id = $1
          ORDER BY created_at DESC`,
        [ctx.meta.docoId],
      ),
      c.query<ArticleRow>(
        `SELECT id, summary, lifecycle, body_md,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM node_authoring_articles
          WHERE doco_id = $1
          ORDER BY created_at DESC`,
        [ctx.meta.docoId],
      ),
    ]);
    const items: ArticleListEntry[] = [
      ...guidance.rows.map((r) => ({
        ...r,
        article_type: "guidance" as const,
        node_type: "guidance_article" as const,
      })),
      ...nodeAuthoring.rows.map((r) => ({
        ...r,
        article_type: "node_authoring" as const,
        node_type: "node_authoring_article" as const,
      })),
    ];
    return Response.json({
      doco_id: ctx.meta.docoId,
      doco_handle: ctx.handle,
      count: items.length,
      guidance_count: guidance.rows.length,
      node_authoring_count: nodeAuthoring.rows.length,
      items,
    });
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams;
}) {
  const { dir, docoSlug, me, meta, ownerSlug } = await loadDocoRouteForRead(
    request,
    params,
    "author",
  );
  if (!me) {
    return Response.json({ error: "Authentication required to write." }, { status: 401 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  const bodyText = await request.text();

  return withIdempotency(
    request,
    "POST /api/articles",
    me.id ?? null,
    bodyText,
    async () => {
      let parsed: { article_type?: unknown } & Record<string, unknown>;
      try {
        parsed = JSON.parse(bodyText);
      } catch (e) {
        return Response.json(
          { error: `Invalid JSON body: ${(e as Error).message}` },
          { status: 400 },
        );
      }
      const articleType = parsed.article_type;
      if (articleType !== "guidance" && articleType !== "node_authoring") {
        return Response.json(
          {
            error:
              'Body must include "article_type": "guidance" | "node_authoring" to disambiguate.',
          },
          { status: 400 },
        );
      }

      const docoRole = await getDocoLevelRole(
        { ownerId: meta.ownerId, docoId: meta.docoId },
        me.id,
      );
      if (!docoRole || !roleAtLeast(docoRole, "author")) {
        return Response.json(
          { error: "Forbidden: author role required to write." },
          { status: 403 },
        );
      }

      const docoHost = new URL(request.url).origin;
      const { article_type: _discarded, ...rest } = parsed;

      if (articleType === "guidance") {
        const draft = rest as unknown as GuidanceArticleDraft;
        if (!draft.authored_by_username) draft.authored_by_username = me.username;
        if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
        const result = await captureGuidanceArticle(
          dir,
          meta.docoId,
          ownerSlug,
          docoSlug,
          draft,
          docoHost,
        );
        if ("error" in result) return Response.json(result, { status: 400 });
        return Response.json(result, { status: 201 });
      }

      const draft = rest as unknown as NodeAuthoringArticleDraft;
      if (!draft.authored_by_username) draft.authored_by_username = me.username;
      if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
      const result = await captureNodeAuthoringArticle(
        dir,
        meta.docoId,
        ownerSlug,
        docoSlug,
        draft,
        docoHost,
      );
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result, { status: 201 });
    },
  );
}
