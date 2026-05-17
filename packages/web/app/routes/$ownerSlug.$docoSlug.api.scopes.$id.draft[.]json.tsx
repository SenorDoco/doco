// POST /<owner>/<doco>/api/scopes/<scope_id>/draft.json
//
// v7. Bulk-flip every active node in the scope (and descendants) back
// to lifecycle=drafted. No validation; the inverse of activate.

import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { reindex } from "~/lib/redeem.server";
import {
  enumerateScopeAndDescendants,
  loadMembersOfScopes,
  bulkUpdateLifecycle,
} from "~/lib/scope-bulk.server";

export function loader() {
  return Response.json(
    { error: "Use POST to flip every active node in this scope and its descendants back to drafted." },
    { status: 405 },
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; id: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { id } = params;
  if (request.method !== "POST") {
    return Response.json({ error: "POST required." }, { status: 405 });
  }
  await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = await readDocoMetadata(dir);
  if (!meta?.docoId) {
    return Response.json({ error: "Doco metadata missing." }, { status: 500 });
  }
  const docoId = meta.docoId;
  const scopeIds = await enumerateScopeAndDescendants(docoId, id);
  if (scopeIds.size === 0) {
    return Response.json({ error: `Scope not found: ${id}` }, { status: 404 });
  }
  const members = await loadMembersOfScopes(docoId, scopeIds);
  const updated = await bulkUpdateLifecycle({
    members,
    targetLifecycle: "drafted",
    onlyFromLifecycles: ["active"],
  });
  if (updated.length > 0) await reindex(dir, docoId, updated);
  return Response.json(
    {
      ok: true,
      scope_id: id,
      scope_count: scopeIds.size,
      drafted_ids: updated,
    },
    { status: 200 },
  );
}
