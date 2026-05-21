import { getPrincipalById, listDocoUsers, upsertEntity, withClient } from "@doco/db";
import { type EntityId, generateUlid, makeEntityId, nowIso } from "@doco/shared";
import { loadDocoRouteForAdmin, loadDocoRouteForRead } from "~/lib/doco-access.server";

const ROLE_PRINCIPAL_USERNAMES = new Set(["user", "human", "doco-host", "github"]);

const DEFAULTS: Record<string, { type: "person" | "agent"; summary: string }> = {
  user: {
    type: "agent",
    summary: "Role principal for any Doco user, whether person or AI agent.",
  },
  human: {
    type: "person",
    summary: "Role principal for the person-only subset of users.",
  },
  "doco-host": {
    type: "agent",
    summary: "System principal for the Doco host service.",
  },
  github: {
    type: "agent",
    summary: "External identity-provider principal for GitHub.",
  },
};

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }

  const { me, meta } = await loadDocoRouteForAdmin(request, params);
  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    type?: "person" | "agent";
    summary?: string;
  };
  const username = String(body.username ?? "")
    .trim()
    .toLowerCase();
  if (!ROLE_PRINCIPAL_USERNAMES.has(username)) {
    return Response.json(
      {
        error:
          "Only the built-in role principals can be created here: user, human, doco-host, github.",
      },
      { status: 400 },
    );
  }

  const existing = await withClient(async (c) =>
    c.query<{ id: string; username: string }>(
      "SELECT id, username FROM principals WHERE username = $1 LIMIT 1",
      [username],
    ),
  );
  if (existing.rows[0]) {
    return Response.json({
      ok: true,
      id: existing.rows[0].id,
      username,
      existed: true,
      footer_lines: [`[🔮 Doco] 👤 Principal already exists: ${username} (${existing.rows[0].id})`],
    });
  }

  const id = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
  const now = nowIso();
  const type = body.type ?? DEFAULTS[username].type;
  const summary = body.summary?.trim() || DEFAULTS[username].summary;
  const raw = {
    id,
    doco_id: meta.docoId,
    node_type: "principal",
    summary,
    type,
    username,
    role_principal: true,
    created_at: now,
    created_by: me?.id ?? id,
    lifecycle: "active",
  };

  await upsertEntity({
    id,
    doco_id: meta.docoId,
    node_type: "principal",
    raw_yaml: JSON.stringify(raw),
    summary,
    lifecycle: "active",
    created_at: now,
    created_by: me?.id ?? null,
    updated_at: now,
    updated_by: me?.id ?? null,
  });

  return Response.json(
    {
      ok: true,
      id,
      username,
      existed: false,
      footer_lines: [`[🔮 Doco] 👤 Principal added: ${username} (${id})`],
    },
    { status: 201 },
  );
}

/**
 * GET — list principals with a direct grant on this Doco.
 *
 * Returns `{ ok: true, principals: [{ id, username, type, role,
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
  params: { docoId: string };
}) {
  const { meta } = await loadDocoRouteForRead(request, params);
  const docoUsers = await listDocoUsers(meta.docoId);
  const principals = await Promise.all(
    docoUsers.map(async (u) => {
      const p = await getPrincipalById(u.principal_id);
      return p
        ? {
            id: p.id,
            username: p.username,
            type: p.type,
            role: u.role,
            github_login: p.github_login ?? null,
            email: p.email ?? null,
          }
        : null;
    }),
  );
  return Response.json({
    ok: true,
    principals: principals.filter((p) => p !== null),
  });
}
