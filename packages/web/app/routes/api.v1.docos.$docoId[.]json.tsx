// GET /api/v1/docos/:docoId.json — resolve a Doco ULID to its current
// canonical owner/slug. The Doco ID never changes; the slug can.
// GitHub's `/repositories/{id}` plays the same role — agents that
// want a stable identifier across renames/transfers record the ID
// once and resolve it to the current slug as needed.
//
// Failure modes are de-conflated (matches /by-id/<id>/* + the
// bootstrap endpoint): a missing id returns 404 with "no Doco with
// this id exists" guidance, a real-but-private Doco returns 403 with
// "ask the owner for access" guidance. ULIDs are 128-bit so existence-
// probing isn't a meaningful enumeration attack.

import { getDocoById } from "@doco/db";
import { canAccessDoco } from "~/lib/doco-access.server";
import {
  hostFromRequest,
  missingDocoResponse,
} from "~/lib/missing-doco-guidance.server";
import { getCurrentPrincipalAsync } from "~/lib/session";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const host = hostFromRequest(request);
  const row = await getDocoById(params.docoId);
  if (!row) {
    return missingDocoResponse({
      state: "not_found",
      identifier: params.docoId,
      host,
    });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (
    !await canAccessDoco(
      { ownerId: row.owner_id, visibility: row.visibility, docoId: row.id },
      me?.id ?? null,
    )
  ) {
    return missingDocoResponse({
      state: "no_access",
      identifier: params.docoId,
      host,
    });
  }
  return Response.json({
    doco_id: row.id,
    owner_slug: row.owner_slug,
    doco_slug: row.doco_slug,
    canonical_path: `/${row.owner_slug}/${row.doco_slug}`,
    visibility: row.visibility,
  });
}
