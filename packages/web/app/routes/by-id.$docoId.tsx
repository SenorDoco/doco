// /by-id/:docoId[/...] — stable Doco links.
//
// Doco handles are mutable; doco ids are not. UI surfaces that need a
// durable link should point here, then resolve to the current handle at
// click time. The redirect keeps the rest of the path intact, so
// /by-id/doco_.../api/decisions.json lands on
// /<current-handle>/api/decisions.json.

import { getDocoByIdOrHandle } from "@doco/db";
import { redirect } from "react-router";
import { canReadDocoForRequest } from "~/lib/doco-access.server";
import { hostFromRequest, missingDocoResponse } from "~/lib/missing-doco-guidance.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId?: string; "*": string };
}) {
  const docoId = params.docoId ?? "";
  const host = hostFromRequest(request);
  const row = await getDocoByIdOrHandle(docoId);
  if (!row) {
    return missingDocoResponse({ state: "not_found", identifier: docoId, host });
  }

  const me = await getCurrentPrincipalAsync(request);
  if (
    !(await canReadDocoForRequest(
      request,
      { ownerId: row.owner_id, visibility: row.visibility, docoId: row.id },
      me?.id ?? null,
    ))
  ) {
    return missingDocoResponse({ state: "no_access", identifier: docoId, host });
  }

  const splat = (params["*"] ?? "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  const path = splat ? `/${row.handle}/${splat}` : `/${row.handle}`;
  const search = new URL(request.url).search;
  return redirect(`${path}${search}`, 307);
}

export const action = loader;
