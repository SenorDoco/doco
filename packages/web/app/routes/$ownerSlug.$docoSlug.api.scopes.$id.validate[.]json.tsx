// POST /<doco-handle>/api/scopes/<scope_id>/validate.json
//
// v7. Re-evaluate the rules engine against every node in the scope
// (and descendants) at its current lifecycle. Returns a violations
// list. No DB writes.

import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import {
  enumerateScopeAndDescendants,
  loadMembersOfScopes,
  validateMembers,
} from "~/lib/scope-bulk.server";

export function loader() {
  return Response.json(
    { error: "Use POST to validate every node in this scope and its descendants." },
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
  await loadDocoForAdmin(request, handle);
  const dir = docoPath(handle);
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
  const results = await validateMembers({
    docoDir: dir,
    ownerSlug,
    docoSlug,
    members,
  });
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  return Response.json(
    {
      scope_id: id,
      scope_count: scopeIds.size,
      member_count: members.length,
      passed: ok,
      failed: failed.length,
      failures: failed,
    },
    { status: 200 },
  );
}
