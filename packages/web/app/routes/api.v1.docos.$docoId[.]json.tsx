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

import { getDocoByIdOrHandle } from "@doco/db";
import { canReadDocoForRequest } from "~/lib/doco-access.server";
import { hostFromRequest, missingDocoResponse } from "~/lib/missing-doco-guidance.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const host = hostFromRequest(request);
  // Phase 1 of slug-removal: the path param now accepts either the
  // ULID (legacy) or the new handle (phase 2 canonical).
  const row = await getDocoByIdOrHandle(params.docoId);
  if (!row) {
    return missingDocoResponse({
      state: "not_found",
      identifier: params.docoId,
      host,
    });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (
    !(await canReadDocoForRequest(
      request,
      { ownerId: row.owner_id, visibility: row.visibility, docoId: row.id },
      me?.id ?? null,
    ))
  ) {
    return missingDocoResponse({
      state: "no_access",
      identifier: params.docoId,
      host,
    });
  }
  return Response.json({
    doco_id: row.id,
    doco_handle: row.handle,
    goal: row.goal,
    owner_username: row.owner_slug,
    canonical_path: `/${row.handle}`,
    visibility: row.visibility,
  });
}
