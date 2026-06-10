import { getUserById, listDocoUsers, listNodesByDoco } from "@doco/db";
import { docoPath } from "~/lib/db.server";
import { loadDocoRouteForRead, requireDocoTypeWriteForRequest } from "~/lib/doco-access.server";
import { capturePrincipal } from "~/lib/principal-capture.server";

// POST — create a Principal (role-persona / process actor). Auth + the
// per-type "principal" write gate live here; the create itself is the shared
// capturePrincipal core (also used by the generic capture registry → changeset
// → authoring contract), so a principal is created identically however it's
// reached.
export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }

  const { me, meta } = await loadDocoRouteForRead(request, params, "reader");
  if (!me) {
    return Response.json(
      { error: "Authentication required to create a principal." },
      { status: 401 },
    );
  }

  const denied = await requireDocoTypeWriteForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
    "principal",
    "create a principal",
  );
  if (denied) return denied;

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    /** Seat occupant kind — "human" or "agent" (a vacant seat sets none). */
    kind?: string;
    lifecycle?: string;
  };

  const result = await capturePrincipal(
    docoPath(params.docoHandle),
    meta.docoId,
    "",
    params.docoHandle,
    // Spread the full body so capturePrincipal's blocked-edge-field guard sees
    // every client field (e.g. reports_to); created_by is forced to the
    // authenticated user regardless of what the client sent.
    { ...body, created_by: me.id },
    new URL(request.url).origin,
  );

  if ("error" in result) {
    return Response.json(
      {
        error: result.error,
        ...(result.policy_id ? { policy_id: result.policy_id } : {}),
        ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      },
      { status: result.status ?? 400 },
    );
  }

  return Response.json(
    {
      ok: true,
      id: result.id,
      name: String(body.name ?? "").trim(),
      existed: false,
      footer_lines: result.footer_lines,
      duration_ms: result.duration_ms,
      ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    },
    { status: 201 },
  );
}

/**
 * GET — list principals with a direct grant on this Doco.
 *
 * Returns `{ ok: true, users: [{ id, username, type, role,
 * github_login, email }] }`. Read access is enough to list — anyone
 * who can see the Doco (per loadDocoRouteForRead) can see the user list.
 *
 * Backs the `list_principals` MCP tool.
 */
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  const { meta } = await loadDocoRouteForRead(request, params);
  // This endpoint lists both OAuth users with grants and actual Principal
  // nodes (role-personas rendered by perspectives).
  const [docoUsers, nodeRows] = await Promise.all([
    listDocoUsers(meta.docoId),
    listNodesByDoco("principal", meta.docoId),
  ]);
  const users = (
    await Promise.all(
      docoUsers.map(async (u) => {
        const c = await getUserById(u.user_id);
        return c
          ? {
              id: c.id,
              username: userDisplayName(c),
              type: "person",
              role: u.role,
              github_login: c.github_login,
              email: c.email,
            }
          : null;
      }),
    )
  ).filter((p) => p !== null);
  const principal_nodes = nodeRows.map((r) => ({
    id: r.id,
    // A principal's name is its `prose`.
    name: r.prose || null,
    lifecycle: r.lifecycle,
    created_at: r.created_at,
    updated_at: r.updated_at,
    ...(r.kind != null ? { kind: r.kind } : {}),
    extra: r.extra,
  }));
  return Response.json({
    ok: true,
    users,
    principal_nodes,
    user_count: users.length,
    principal_node_count: principal_nodes.length,
  });
}

function userDisplayName(c: Awaited<ReturnType<typeof getUserById>>): string {
  if (!c) return "";
  const named = c.data.name ?? c.data.display_name;
  if (typeof named === "string" && named.trim()) return named.trim();
  return c.github_login ?? c.id;
}
