// GET /api/v1/docos/:docoId.json — resolve a Doco ULID to its current
// canonical owner/slug. The Doco ID never changes; the slug can.
// GitHub's `/repositories/{id}` plays the same role — agents that
// want a stable identifier across renames/transfers record the ID
// once and resolve it to the current slug as needed.
//
// Applies the same privacy gate as the per-Doco data routes so this
// endpoint can't be used to enumerate private docos by ID guessing.

import { getDocoById } from "@doco/db";
import { canAccessDoco } from "~/lib/doco-access.server";
import { getCurrentPrincipalAsync } from "~/lib/session";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const row = await getDocoById(params.docoId);
  if (!row) {
    return new Response(`Doco "${params.docoId}" not found.`, { status: 404 });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (
    !await canAccessDoco({ ownerId: row.owner_id, visibility: row.visibility }, me?.id ?? null)
  ) {
    // Same 404-not-403 convention as the per-Doco routes — don't leak
    // existence of a private Doco to ID-guessing callers.
    return new Response(`Doco "${params.docoId}" not found.`, { status: 404 });
  }
  return Response.json({
    doco_id: row.id,
    owner_slug: row.owner_slug,
    doco_slug: row.doco_slug,
    canonical_path: `/${row.owner_slug}/${row.doco_slug}`,
    visibility: row.visibility,
  });
}
