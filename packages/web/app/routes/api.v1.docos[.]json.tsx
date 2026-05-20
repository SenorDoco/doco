// POST /api/v1/docos.json — create a Doco (v13).
//
// Body (JSON):
//   { org_id: string,                  // ULID of the owning organization
//     requested_suffix: string,        // the part after `<org-handle>-`
//     template_handle?: string,        // "generic" | "user-flows" | ...
//     visibility?: "private"|"public", // default "private"
//     description?: string }
//
// Behavior:
//   - The caller must have ANY membership in the target org.
//   - The full doco handle is composed as `<org-handle>-<requested_suffix>`
//     and silently auto-suffixed `-2`, `-3`, … on collision.
//   - The template's rule set + `allowed_node_types` +
//     `default_node_lifecycle` are seeded onto the new Doco (matches
//     what the /new-doco web flow does).
//   - Returns 201 with `{ id, handle, org_id, org_handle }`.

import { withClient } from "@doco/db";
import { createDocoInOrg } from "@doco/host";
import { getCurrentPrincipal } from "~/lib/session";

export async function loader() {
  return Response.json({ error: "Use POST to create a Doco." }, { status: 405 });
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
  let body: {
    org_id?: unknown;
    requested_suffix?: unknown;
    template_handle?: unknown;
    visibility?: unknown;
    description?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch (e) {
    return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
  }
  const orgId = typeof body.org_id === "string" ? body.org_id.trim() : "";
  const suffix = typeof body.requested_suffix === "string" ? body.requested_suffix.trim() : "";
  const templateHandle =
    typeof body.template_handle === "string" ? body.template_handle.trim() : null;
  const visibility = body.visibility === "public" ? "public" : "private";
  const description = typeof body.description === "string" ? body.description : undefined;

  if (!orgId) return Response.json({ error: "`org_id` is required." }, { status: 400 });
  if (!suffix) return Response.json({ error: "`requested_suffix` is required." }, { status: 400 });

  // Verify the caller is a member of the org.
  const membership = await withClient((c) =>
    c.query<{ role: string }>(
      "SELECT role FROM org_users WHERE org_id = $1 AND principal_id = $2 LIMIT 1",
      [orgId, me.id],
    ),
  );
  if ((membership.rowCount ?? 0) === 0) {
    return Response.json(
      { error: "You are not a member of this organization." },
      { status: 403 },
    );
  }

  try {
    const rec = await createDocoInOrg({
      orgId,
      requestedSuffix: suffix,
      createdByPrincipalId: me.id,
      visibility,
      autoSuffix: true,
      ...(templateHandle && templateHandle !== "generic"
        ? { templateHandle }
        : { templateHandle: null }),
      ...(description ? { description } : {}),
    });
    return Response.json(
      { id: rec.docoId, handle: rec.handle, org_id: rec.orgId, org_handle: rec.orgHandle },
      { status: 201 },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
