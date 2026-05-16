import { upsertEntity, withClient } from "@doco/db";
import { type EntityId, generateUlid, makeEntityId, nowIso } from "@doco/shared";
import { loadDocoForAdmin } from "~/lib/doco-access.server";

const ROLE_PRINCIPAL_USERNAMES = new Set(["user", "human", "doco-host", "github"]);

const DEFAULTS: Record<
  string,
  { display_name: string; type: "human" | "agent"; summary: string }
> = {
  user: {
    display_name: "User",
    type: "agent",
    summary: "Role principal for any Doco user, whether human or AI agent.",
  },
  human: {
    display_name: "Human",
    type: "human",
    summary: "Role principal for the human-only subset of users.",
  },
  "doco-host": {
    display_name: "Doco host",
    type: "agent",
    summary: "System principal for the Doco host service.",
  },
  github: {
    display_name: "GitHub",
    type: "agent",
    summary: "External identity-provider principal for GitHub.",
  },
};

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }

  const { me, meta } = await loadDocoForAdmin(request, params.ownerSlug, params.docoSlug);
  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    display_name?: string;
    type?: "human" | "agent";
    summary?: string;
  };
  const username = String(body.username ?? "").trim().toLowerCase();
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
    c.query<{ id: string; username: string; display_name: string | null }>(
      "SELECT id, username, display_name FROM principals WHERE username = $1 LIMIT 1",
      [username],
    ),
  );
  const displayName = body.display_name?.trim() || DEFAULTS[username].display_name;
  if (existing.rows[0]) {
    return Response.json({
      ok: true,
      id: existing.rows[0].id,
      username,
      existed: true,
      footer_lines: [
        `[🔮 Doco] 👤 Principal already exists: ${displayName} (${existing.rows[0].id})`,
      ],
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
    display_name: displayName,
    role_principal: true,
    created_at: now,
    created_by: me?.id ?? id,
    lifecycle: "active",
    scopes: [],
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
      footer_lines: [`[🔮 Doco] 👤 Principal added: ${displayName} (${id})`],
    },
    { status: 201 },
  );
}

export async function loader() {
  return Response.json({ error: "Use POST." }, { status: 405 });
}
