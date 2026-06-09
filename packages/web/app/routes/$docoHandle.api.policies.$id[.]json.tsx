// GET/PATCH /<doco-handle>/api/policies/<id>.json — read or modify one policy.
//
// Policies are NOT nodes (they live in their own `policies` table), so this
// route can't ride the generic node-update factory — it speaks the real policy
// primitives directly, the same ones the HTML edit page uses:
//   GET   → loadPolicyForEdit: the stored draft fields + lifecycle.
//   PATCH → modify (owner role required), two shapes:
//     • { "lifecycle": "retired" | "active" } — a pure lifecycle transition
//       (retire / re-activate), via transitionPolicyLifecycle.
//     • a full policy draft (must include "kind") — SUPERSEDE: capture a new
//       policy from the draft and retire this one with superseded_by:<new id>,
//       preserving the enforcement history in the audit trail (the same model
//       the /<doco>/policies/<id>/edit page applies). The response carries the
//       NEW policy id.
//
// Owner-only, matching POST /api/policies.json — policies are owner-governed.

import { type PolicyPredicate, summarizePredicate } from "@doco/shared";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import {
  type PolicyDraft,
  capturePolicy,
  loadPolicyForEdit,
  transitionPolicyLifecycle,
} from "~/lib/capture.server";
import {
  type DocoRouteParams,
  getDocoLevelRoleForRequest,
  loadDocoRouteForRead,
} from "~/lib/doco-access.server";
import { resolvePrincipalIdForUser } from "~/lib/principal-user.server";

interface PolicyIdRouteParams extends DocoRouteParams {
  id: string;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: PolicyIdRouteParams;
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const result = await loadPolicyForEdit({
    scope: "doco",
    scopeId: ctx.meta.docoId,
    policyId: params.id,
  });
  if ("error" in result) {
    return Response.json({ error: result.error }, { status: result.status ?? 404 });
  }
  const data = result.data ?? {};
  const predicate = (data.predicate ?? null) as PolicyPredicate | null;
  return Response.json({
    // Stored draft first, then the authoritative identity/lifecycle on top.
    ...data,
    id: params.id,
    kind: typeof data.kind === "string" ? data.kind : null,
    summary: predicate ? summarizePredicate(predicate) : "",
    predicate,
    lifecycle: result.lifecycle,
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: PolicyIdRouteParams;
}) {
  const { dir, docoSlug, me, meta, ownerSlug } = await loadDocoRouteForRead(
    request,
    params,
    "owner",
  );
  if (!me) {
    return Response.json({ error: "Authentication required to edit." }, { status: 401 });
  }
  if (request.method !== "PATCH" && request.method !== "POST") {
    return Response.json({ error: "Use PATCH or POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  let body: { kind?: unknown; lifecycle?: unknown } & Record<string, unknown>;
  try {
    body = JSON.parse(await request.text());
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }

  // Capped for Señor Doco: the agent never resolves to owner, so it can never
  // modify policies even when the underlying human is the owner — matching the
  // capture endpoint.
  const docoRole = await getDocoLevelRoleForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
  );
  if (docoRole !== "owner") {
    return Response.json(
      { error: "Forbidden: owner role required to modify policies." },
      { status: 403 },
    );
  }

  // A content modify carries the new policy draft (keyed by `kind`). A body
  // without `kind` is a pure lifecycle transition.
  if (typeof body.kind !== "string") {
    const lifecycle = body.lifecycle;
    if (lifecycle !== "retired" && lifecycle !== "active") {
      return Response.json(
        {
          error:
            'Body must be a policy draft (include "kind") to modify, or { "lifecycle": "retired" | "active" } to transition.',
        },
        { status: 400 },
      );
    }
    const result = await transitionPolicyLifecycle({
      scope: "doco",
      scopeId: meta.docoId,
      policyId: params.id,
      newLifecycle: lifecycle,
      actorId: me.id ?? null,
    });
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: result.status ?? 400 });
    }
    return Response.json({ ok: true, id: params.id, lifecycle });
  }

  // Content modify = supersession: capture a new policy from the draft, then
  // retire this one with superseded_by:<new id>. Confirm the target exists
  // first so a typo'd id fails cleanly instead of leaving an orphan new policy.
  const existing = await loadPolicyForEdit({
    scope: "doco",
    scopeId: meta.docoId,
    policyId: params.id,
  });
  if ("error" in existing) {
    return Response.json({ error: existing.error }, { status: existing.status ?? 404 });
  }

  const docoHost = new URL(request.url).origin;
  const draft = stampAuthenticatedCreator(body as unknown as PolicyDraft, me.id);
  if (!draft.authored_by_principal_id && me.id) {
    draft.authored_by_principal_id =
      (await resolvePrincipalIdForUser(meta.docoId, me.id)) ?? undefined;
  }
  const captured = await capturePolicy(dir, meta.docoId, ownerSlug, docoSlug, draft, docoHost, {
    authoring: await authoringContextForRequest(request),
  });
  if ("error" in captured) {
    return Response.json(captured, {
      status: (captured as { status?: number }).status ?? 400,
    });
  }
  const transitioned = await transitionPolicyLifecycle({
    scope: "doco",
    scopeId: meta.docoId,
    policyId: params.id,
    newLifecycle: "retired",
    supersededBy: captured.id,
    actorId: me.id ?? null,
    reason: `superseded_by:${captured.id}`,
  });
  if ("error" in transitioned) {
    return Response.json({ error: transitioned.error }, { status: 500 });
  }
  return Response.json(
    { ok: true, id: captured.id, superseded: params.id, footer_lines: captured.footer_lines },
    { status: 201 },
  );
}
