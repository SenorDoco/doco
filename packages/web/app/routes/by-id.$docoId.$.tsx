// /by-id/:docoId/* — splat redirect from ID-keyed URL to canonical slug-keyed
// URL. GitHub's `/repositories/{id}/*` plays the same role: agents that
// hold an immortal doco_id never have to track slug changes, and the
// redirect lets them learn the canonical at request time.
//
// Status 308 preserves request method, so POST/PATCH at /by-id/<id>/api/...
// retry cleanly at /<owner>/<slug>/api/... on the same call.
//
// Privacy gate: same 404 conflation as the per-Doco routes — an agent
// can't probe by ID to discover private docos they don't own.

import { redirect } from "react-router";
import { getDocoById } from "@doco/db";
import { canAccessDoco } from "~/lib/doco-access.server";
import { getCurrentPrincipalAsync } from "~/lib/session";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; "*": string | undefined };
}) {
  const row = await getDocoById(params.docoId);
  if (!row) {
    return new Response(`Doco "${params.docoId}" not found.`, { status: 404 });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (
    !await canAccessDoco({ ownerId: row.owner_id, visibility: row.visibility }, me?.id ?? null)
  ) {
    return new Response(`Doco "${params.docoId}" not found.`, { status: 404 });
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
