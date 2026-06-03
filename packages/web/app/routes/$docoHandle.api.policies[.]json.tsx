// GET/POST /<doco-handle>/api/policies.json — dedicated policies endpoint.
//
// Policies are not nodes. They are Doco-level authoring metadata and are
// *only* reachable from this endpoint, the agent bootstrap response, or the
// HTML policies page. The generic /<handle>/api/<type>.json dispatcher refuses
// the `policy` type.
//
// GET  → list every policy in the Doco, each with its `kind`
//        ("suggestion" | "deterministic" | "probabilistic") and predicate.
// POST → capture a new policy. Body shape:
//        { "kind": "suggestion" | "deterministic" | "probabilistic", ...draft }
//        where `...draft` follows PolicyDraft from capture.server.ts
//        (suggestion/probabilistic → `agent_instruction`; deterministic →
//        `predicate` with `sub_kind`).

import { withClient } from "@doco/db";
import { type PolicyPredicate, summarizePredicate } from "@doco/shared";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import { type PolicyDraft, capturePolicy } from "~/lib/capture.server";
import {
  type DocoRouteParams,
  getDocoLevelRole,
  loadDocoRouteForRead,
} from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";
import { resolvePrincipalIdForUser } from "~/lib/principal-user.server";

interface PolicyRow {
  id: string;
  kind: string | null;
  data: Record<string, unknown> | null;
  lifecycle: string | null;
  created_at: string | null;
  updated_at: string | null;
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
    const rows = await c.query<PolicyRow>(
      `SELECT id, kind, data, lifecycle,
              created_at::text AS created_at,
              updated_at::text AS updated_at
         FROM policies
        WHERE doco_id = $1
        ORDER BY created_at DESC`,
      [ctx.meta.docoId],
    );
    const items = rows.rows.map((r) => {
      const data = r.data ?? {};
      const predicate = (data.predicate ?? null) as PolicyPredicate | null;
      return {
        id: r.id,
        kind: r.kind ?? (typeof data.kind === "string" ? data.kind : null),
        summary: predicate ? summarizePredicate(predicate) : "",
        predicate,
        lifecycle: r.lifecycle,
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });
    const countByKind = (kind: string) => items.filter((i) => i.kind === kind).length;
    return Response.json({
      doco_id: ctx.meta.docoId,
      doco_handle: ctx.handle,
      count: items.length,
      suggestion_count: countByKind("suggestion"),
      deterministic_count: countByKind("deterministic"),
      probabilistic_count: countByKind("probabilistic"),
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
    "owner",
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

  return withIdempotency(request, "POST /api/policies", me.id ?? null, bodyText, async () => {
    let parsed: { kind?: unknown } & Record<string, unknown>;
    try {
      parsed = JSON.parse(bodyText);
    } catch (e) {
      return Response.json(
        { error: `Invalid JSON body: ${(e as Error).message}` },
        { status: 400 },
      );
    }
    const kind = parsed.kind;
    if (kind !== "suggestion" && kind !== "deterministic" && kind !== "probabilistic") {
      return Response.json(
        {
          error: 'Body must include "kind": "suggestion" | "deterministic" | "probabilistic".',
        },
        { status: 400 },
      );
    }

    const docoRole = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
    if (docoRole !== "owner") {
      return Response.json(
        { error: "Forbidden: owner role required to write policies." },
        { status: 403 },
      );
    }

    const docoHost = new URL(request.url).origin;
    const draft = stampAuthenticatedCreator(parsed as unknown as PolicyDraft, me.id);
    if (!draft.authored_by_principal_id && me.id) {
      draft.authored_by_principal_id =
        (await resolvePrincipalIdForUser(meta.docoId, me.id)) ?? undefined;
    }
    const result = await capturePolicy(dir, meta.docoId, ownerSlug, docoSlug, draft, docoHost, {
      authoring: await authoringContextForRequest(request),
    });
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result, { status: 201 });
  });
}
