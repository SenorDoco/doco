// POST /api/v1/orgs.json — create an Organization (v13).
//
// Body (JSON):
//   { requested_id: string }
//
// Behavior:
//   - The caller (any authenticated principal) becomes the new org's
//     `owner` in `org_users`.
//   - The server normalizes `requested_id` to kebab-case and silently
//     appends `-2`, `-3`, … on collision (API-side `autoSuffix: true`).
//   - Returns 201 with `{ id, handle }`. The `id` is the internal ULID;
//     `handle` is the (possibly suffixed) public identifier.
//
// Auth: requires a signed-in principal (cookie session or OAuth bearer).
// Rate-limiting / abuse controls are out of scope for v13.

import { addOrganizationByHandle } from "@doco/host";
import { getCurrentPrincipal } from "~/lib/session";

export async function loader() {
  return Response.json({ error: "Use POST to create an organization." }, { status: 405 });
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const me = await getCurrentPrincipal(request);
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
    return Response.json(
      { error: "`requested_id` is required (string)." },
      { status: 400 },
    );
  }
  try {
    const { id, handle } = await addOrganizationByHandle({
      handle: requested.trim().toLowerCase(),
      ownerPrincipalId: me.id,
      autoSuffix: true,
    });
    return Response.json({ id, handle }, { status: 201 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
