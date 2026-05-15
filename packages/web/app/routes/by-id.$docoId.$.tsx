// /by-id/:docoId/* — splat redirect from ID-keyed URL to canonical slug-keyed
// URL. GitHub's `/repositories/{id}/*` plays the same role: agents that
// hold an immortal doco_id never have to track slug changes, and the
// redirect lets them learn the canonical at request time.
//
// Status 308 preserves request method, so POST/PATCH at /by-id/<id>/api/...
// retry cleanly at /<owner>/<slug>/api/... on the same call.
//
// Failure modes are de-conflated: a missing id returns 404 with
// "no Doco with this id exists" guidance, a real-but-private Doco
// returns 403 with "ask the owner for access" guidance. Probing for
// existence isn't a meaningful enumeration attack — ULIDs are 128-bit
// (effectively unguessable), and telling an inaccessible-but-real
// caller to `doco login --create` would fork a duplicate Doco when
// the real one is right there.

import { redirect } from "react-router";
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
  params: { docoId: string; "*": string | undefined };
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
    !await canAccessDoco({ ownerId: row.owner_id, visibility: row.visibility }, me?.id ?? null)
  ) {
    return missingDocoResponse({
      state: "no_access",
      identifier: params.docoId,
      host,
    });
  }
  const url = new URL(request.url);
  const prefix = `/by-id/${params.docoId}`;
  const rest = url.pathname.startsWith(`${prefix}/`)
    ? url.pathname.slice(prefix.length + 1)
    : params["*"] ?? "";
  const target = `/${row.owner_slug}/${row.doco_slug}${rest ? `/${rest}` : ""}${url.search}`;
  throw redirect(target, { status: 308 });
}

// Action mirrors loader so POST/PATCH/DELETE also redirect.
export const action = loader;
