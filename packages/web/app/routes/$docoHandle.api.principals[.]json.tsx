import {
  getCollaboratorById,
  listDocoUsers,
  roleAtLeast,
  upsertEntity,
  withClient,
} from "@doco/db";
import { type EntityId, generateUlid, makeEntityId, nowIso } from "@doco/shared";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";

const ROLE_PRINCIPAL_USERNAMES = new Set(["user", "human", "doco-host", "github"]);
const PRINCIPAL_USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

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

  const { me, meta } = await loadDocoRouteForRead(request, params, "author");
  if (!me) {
    return Response.json(
      { error: "Authentication required to create a principal." },
      { status: 401 },
    );
  }

  const docoRole = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
  if (!docoRole || !roleAtLeast(docoRole, "author")) {
    return Response.json(
      { error: "Forbidden: author role required to create a principal." },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    type?: "person" | "agent";
    summary?: string;
    display_name?: string;
    description?: string;
    body_md?: string;
  };
  const username = String(body.username ?? "")
    .trim()
    .toLowerCase();
  if (!username) {
    return Response.json({ error: "username is required." }, { status: 400 });
  }
  if (!PRINCIPAL_USERNAME_PATTERN.test(username)) {
    return Response.json(
      {
        error:
          "Principal username can use lowercase letters, numbers, hyphens, or underscores, and must start with a letter or number.",
      },
      { status: 400 },
    );
  }
  if (body.type !== undefined && body.type !== "person" && body.type !== "agent") {
    return Response.json({ error: "type must be one of: person, agent." }, { status: 400 });
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
  const defaults = DEFAULTS[username];
  const type = body.type ?? defaults?.type;
  const displayName = body.display_name?.trim();
  const description = body.description?.trim();
  const summary = body.summary?.trim() || defaults?.summary || displayName || username;
  const bodyMd = body.body_md?.trim() ?? "";
  const raw = {
    id,
    doco_id: meta.docoId,
    neuron_type: "principal",
    summary,
    ...(type ? { type } : {}),
    username,
    ...(displayName ? { display_name: displayName } : {}),
    ...(description ? { description } : {}),
    ...(ROLE_PRINCIPAL_USERNAMES.has(username) ? { role_principal: true } : {}),
    created_at: now,
    created_by: me.id,
    lifecycle: "active",
  };

  await upsertEntity({
    id,
    doco_id: meta.docoId,
    entity_type: "principal",
    data: raw,
    summary,
    body_md: bodyMd,
    lifecycle: "active",
    created_at: now,
    created_by: me.id,
    updated_at: now,
    updated_by: me.id,
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
  // Post-rename: doco_users.collaborator_id points at the collaborators
  // table (the OAuth identity layer). The legacy field names — username,
  // type, github_login, email — are preserved in the response shape for
  // API back-compat with existing consumers.
  const principals = await Promise.all(
    docoUsers.map(async (u) => {
      const c = await getCollaboratorById(u.collaborator_id);
      return c
        ? {
            id: c.id,
            username: c.github_login ?? c.id,
            type: c.kind,
            role: u.role,
            github_login: c.github_login,
            email: c.email,
          }
        : null;
    }),
  );
  return Response.json({
    ok: true,
    principals: principals.filter((p) => p !== null),
  });
}
