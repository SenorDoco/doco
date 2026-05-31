// GET  /api/v1/docos.json — list Docos the caller can read or write.
// POST /api/v1/docos.json — create a Doco in one step.
//
// GET response:
//   { docos: [{ id, handle, org_id, org_handle, qualified_handle }] }
// Empty array when the caller has access to nothing. Sorted by
// `org_handle/handle` for stable client rendering. The set matches
// the dashboard / OAuth-approve "what can I see?" view: direct
// ownership ∪ org membership ∪ explicit `doco_users` grant.
//
// POST body (JSON):
//   { template_handle?: string,        // "generic" | "business-processes" | ...
//     org_id: string,                  // ULID of the owning organization
//     name: string,                    // requested globally-unique handle
//     privacy?: "private"|"public",    // alias: visibility
//     goal?: string,                   // free-form sentence about what
//                                      // the Doco is for; defaults to
//                                      // the template's description
//                                      // (or empty for no template)
//     constitution?: string }          // project-level governing charter;
//                                      // defaults to the standing
//                                      // spec-driven default text
//
// Back-compat: `requested_suffix` and `visibility` are still accepted
// as aliases for `name` and `privacy`.
//
// Behavior: caller must hold owner on the target org. The requested
// handle is silently auto-suffixed on collision. Returns 201 with
// `{ id, handle, org_id, org_handle, qualified_handle, visibility, goal,
// constitution, chat_conversation_id }`.

import { getOrgRole, roleAtLeast, withClient } from "@doco/db";
import { listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";
import { qualifiedDocoLabel } from "~/lib/doco-labels";
import { createDocoInOrg } from "~/lib/redeem.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipalAsync(request);
  if (!me) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  const ids = await listAccessibleDocoIdsForPrincipal(me.id);
  if (ids.length === 0) {
    return Response.json({ docos: [] });
  }
  const rows = await withClient(async (c) => {
    const r = await c.query<{ id: string; handle: string; org_id: string; org_handle: string }>(
      `SELECT d.id, d.handle, d.org_id, o.handle AS org_handle
         FROM docos d
         JOIN organizations o ON o.id = d.org_id
        WHERE d.id = ANY($1::text[])
        ORDER BY o.handle ASC, d.handle ASC`,
      [ids],
    );
    return r.rows;
  });
  return Response.json({
    docos: rows.map((r) => ({
      id: r.id,
      handle: r.handle,
      org_id: r.org_id,
      org_handle: r.org_handle,
      qualified_handle: qualifiedDocoLabel({ ownerSlug: r.org_handle, handle: r.handle }),
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
  let body: {
    name?: unknown;
    doco_name?: unknown;
    org_id?: unknown;
    requested_suffix?: unknown;
    template_handle?: unknown;
    privacy?: unknown;
    visibility?: unknown;
    goal?: unknown;
    constitution?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch (e) {
    return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
  }
  const orgId = typeof body.org_id === "string" ? body.org_id.trim() : "";
  const requestedName =
    (typeof body.name === "string" ? body.name.trim() : "") ||
    (typeof body.doco_name === "string" ? body.doco_name.trim() : "") ||
    (typeof body.requested_suffix === "string" ? body.requested_suffix.trim() : "");
  const handle = requestedName.toLowerCase();
  const templateHandle =
    typeof body.template_handle === "string" ? body.template_handle.trim() : null;
  const privacy = body.privacy ?? body.visibility;
  const visibility = privacy === "public" ? "public" : "private";
  // Goal is optional. If the caller omits it, the host defaults to the
  // chosen template's description (or empty when no template). If the
  // caller supplies any string — including "" — the host treats that
  // as an explicit override.
  const goal = typeof body.goal === "string" ? body.goal : undefined;
  // Constitution is optional, same contract as goal: omit to take the
  // standing default, or pass any string (including "") to override.
  const constitution = typeof body.constitution === "string" ? body.constitution : undefined;

  if (!orgId) return Response.json({ error: "`org_id` is required." }, { status: 400 });
  if (!handle) return Response.json({ error: "`name` is required." }, { status: 400 });

  const orgRole = await getOrgRole(orgId, me.id);
  if (!roleAtLeast(orgRole, "owner")) {
    return Response.json(
      {
        error: orgRole
          ? `Only org owners can create docos -- you hold '${orgRole}' on this org.`
          : "Only org owners can create docos.",
      },
      { status: 403 },
    );
  }

  try {
    const rec = await createDocoInOrg({
      orgId,
      requestedHandle: handle,
      createdByUserId: me.id,
      visibility,
      autoSuffix: true,
      ...(templateHandle && templateHandle !== "generic"
        ? { templateHandle }
        : { templateHandle: null }),
      ...(goal !== undefined ? { goal } : {}),
      ...(constitution !== undefined ? { constitution } : {}),
    });
    return Response.json(
      {
        id: rec.docoId,
        handle: rec.handle,
        org_id: rec.orgId,
        org_handle: rec.orgHandle,
        qualified_handle: qualifiedDocoLabel({ ownerSlug: rec.orgHandle, handle: rec.handle }),
        visibility,
        goal: rec.goal,
        constitution: rec.constitution,
        chat_conversation_id: rec.companionChatId ?? null,
      },
      { status: 201 },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
