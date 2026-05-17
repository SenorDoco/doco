// POST /<doco-handle>/api/scopes/<scope_id>/activate.json
//
// v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG). Bulk-flip every drafted
// node in the scope (and descendants) to lifecycle=active, after
// re-running the rules engine on each candidate. Aborts on the first
// validation failure — no nodes are persisted unless all pass.

import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { reindex } from "~/lib/redeem.server";
import {
  enumerateScopeAndDescendants,
  loadMembersOfScopes,
  validateMembers,
  bulkUpdateLifecycle,
} from "~/lib/scope-bulk.server";

export function loader() {
  return Response.json(
    { error: "Use POST to activate every drafted node in this scope and its descendants." },
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
  const drafted = members.filter((m) => m.fm.lifecycle === "drafted");
  if (drafted.length === 0) {
    return Response.json(
      {
        ok: true,
        scope_id: id,
        scope_count: scopeIds.size,
        drafted_count: 0,
        activated_ids: [],
        message: "Nothing to do — no drafted members in scope.",
      },
      { status: 200 },
    );
  }
  // v7 semantics: every member of the batch must satisfy completeness
  // rules with ALL OTHER batch members also flipped (e.g., D5's "≥1
  // active initial State" passes only if it sees its sibling States as
  // also active). Implementing this as persist-then-validate-then-revert
  // — the per-candidate engine reloads members from Postgres on each
  // call, so the only way to make the batch flip visible is to actually
  // write it first.
  const updated = await bulkUpdateLifecycle({
    members: drafted,
    targetLifecycle: "active",
    onlyFromLifecycles: ["drafted"],
  });
  const refreshed = await loadMembersOfScopes(docoId, scopeIds);
  const updatedSet = new Set(updated);
  const updatedMembers = refreshed.filter((m) => updatedSet.has(m.id));
  const validation = await validateMembers({
    docoDir: dir,
    ownerSlug,
    docoSlug,
    members: updatedMembers,
  });
  const failures = validation.filter((v) => !v.ok);
  if (failures.length > 0) {
    // Revert: flip them all back to drafted. Best-effort; if the revert
    // itself fails, the project owner can run `doco scope draft <scope>`.
    await bulkUpdateLifecycle({
      members: updatedMembers,
      targetLifecycle: "drafted",
      onlyFromLifecycles: ["active"],
    });
    return Response.json(
      {
        error: `Activation aborted — ${failures.length} of ${updated.length} node(s) failed rules. Reverted to drafted.`,
        failures,
      },
      { status: 400 },
    );
  }
  await reindex(dir, docoId, updated);
  return Response.json(
    {
      ok: true,
      scope_id: id,
      scope_count: scopeIds.size,
      drafted_count: drafted.length,
      activated_ids: updated,
    },
    { status: 200 },
  );
}
