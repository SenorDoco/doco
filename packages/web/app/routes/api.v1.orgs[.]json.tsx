// GET  /api/v1/orgs.json — list Organizations the caller belongs to.
// POST /api/v1/orgs.json — create an Organization (v15).
//
// GET response: { orgs: [{ id, handle, name, member_count }] }.
// Empty array when the caller is in no orgs. Sorted by handle ASC
// for stable client rendering. A cookie session lists every org the
// caller belongs to; an OAuth bearer is narrowed to the orgs the token
// can reach (granted orgs ∪ orgs that own a granted Doco) so a scoped
// token never enumerates the caller's other organizations.
//
// POST body (JSON): { requested_id: string }
//
// POST behavior: caller becomes `owner` in `org_users`; server
// normalizes requested_id to kebab-case and silently appends `-2`,
// `-3`, … on collision (API path uses `autoSuffix: true`). Returns
// 201 with `{ id, handle }` — `id` is the internal ULID; `handle`
// is the (possibly suffixed) public identifier.
//
// Auth: requires a signed-in principal (cookie session or OAuth
// bearer). Rate-limiting is out of scope.

import { listOrganizationsForUser } from "@doco/db";
import { tokenReachableOrgIdsForRequest } from "~/lib/doco-access.server";
import { addOrganizationByHandle } from "~/lib/redeem.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const rows = await listOrganizationsForUser(me.id);
  // Cookie sessions see every membership org; an OAuth bearer is scoped
  // to the orgs it can reach so a token can't enumerate the caller's
  // other organizations.
  const reachable = await tokenReachableOrgIdsForRequest(request);
  const visible = reachable ? rows.filter((r) => reachable.has(r.id)) : rows;
  visible.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
  return Response.json({
    orgs: visible.map((r) => ({
      id: r.id,
      handle: r.handle,
      name: r.name,
      member_count: r.member_count,
    })),
  });
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
  }
  const requested = (body as { requested_id?: unknown })?.requested_id;
  if (typeof requested !== "string" || !requested.trim()) {
    return Response.json({ error: "`requested_id` is required (string)." }, { status: 400 });
  }
  try {
    const { id, handle } = await addOrganizationByHandle({
      handle: requested.trim().toLowerCase(),
      ownerUserId: me.id,
      autoSuffix: true,
    });
    return Response.json({ id, handle }, { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
