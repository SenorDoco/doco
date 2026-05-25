import {
  getCollaboratorById,
  getEntity,
  listDocoUsers,
  listEntitiesByDoco,
  roleAtLeast,
  upsertEntity,
  withClient,
} from "@doco/db";
import { type EntityId, generateUlid, makeEntityId, nowIso } from "@doco/shared";
import { runAuthoringPolicies } from "~/lib/authoring-runner.server";
import { reindexAndScheduleAttach } from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";

const ROLE_PRINCIPAL_NAMES = new Set(["user", "human", "doco-host", "github"]);
const PRINCIPAL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const DEFAULT_SUMMARIES: Record<string, string> = {
  user: "Role principal for any Doco user, whether person or AI agent.",
  human: "Role principal for the person-only subset of users.",
  "doco-host": "System principal for the Doco host service.",
  github: "External identity-provider principal for GitHub.",
};

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
    name?: string;
    summary?: string;
    body_md?: string;
    reports_to?: string;
  };
  const name = String(body.name ?? "")
    .trim()
    .toLowerCase();
  if (!name) {
    return Response.json({ error: "name is required." }, { status: 400 });
  }
  if (!PRINCIPAL_NAME_PATTERN.test(name)) {
    return Response.json(
      {
        error:
          "Principal name can use lowercase letters, numbers, hyphens, or underscores, and must start with a letter or number.",
      },
      { status: 400 },
    );
  }
  if (body.reports_to !== undefined) {
    if (typeof body.reports_to !== "string" || !body.reports_to.startsWith("principal_")) {
      return Response.json(
        { error: "reports_to must be a principal id (principal_<ULID>)." },
        { status: 400 },
      );
    }
    const manager = await getEntity("principal", body.reports_to as EntityId<"principal">);
    if (!manager || manager.doco_id !== meta.docoId) {
      return Response.json(
        { error: `reports_to principal not found in this Doco: ${body.reports_to}` },
        { status: 400 },
      );
    }
  }

  const existing = await withClient(async (c) =>
    c.query<{ id: string; name: string }>(
      "SELECT id, name FROM principals WHERE name = $1 AND doco_id = $2 LIMIT 1",
      [name, meta.docoId],
    ),
  );
  if (existing.rows[0]) {
    return Response.json({
      ok: true,
      id: existing.rows[0].id,
      name,
      existed: true,
      footer_lines: [`[🔮 Doco] 👤 Principal already exists: ${name} (${existing.rows[0].id})`],
    });
  }

  const id = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
  const now = nowIso();
  const summary = body.summary?.trim() || DEFAULT_SUMMARIES[name] || name;
  const bodyMd = body.body_md?.trim() ?? "";
  const raw = {
    id,
    doco_id: meta.docoId,
    neuron_type: "principal",
    summary,
    name,
    ...(body.reports_to ? { reports_to: body.reports_to } : {}),
    ...(ROLE_PRINCIPAL_NAMES.has(name) ? { role_principal: true } : {}),
    created_at: now,
    created_by: me.id,
    lifecycle: "active",
  };

  // Run the doco's authoring policies against the Principal before
  // persisting. Reuses the same evaluator the generic capture routes
  // call, so per-template policies that target Principals (the
  // `org-chart` template ships several) get a chance to block or warn.
  const pred = await runAuthoringPolicies({
    docoId: meta.docoId,
    candidate: raw as Parameters<typeof runAuthoringPolicies>[0]["candidate"],
  });
  if (pred.blocking) {
    return Response.json(
      {
        error: `Authoring policy violation: ${pred.blocking.reason}`,
        policy_id: pred.blocking.policy_id,
        ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
      },
      { status: 422 },
    );
  }

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

  // Reindex so derived rows (synapses table for `reports_to`, FTS,
  // embeddings) reflect the new Principal. Other capture routes do this
  // via the generic capture factory; principals use a bespoke handler
  // and need to call the helper directly.
  await reindexAndScheduleAttach(docoPath(params.docoHandle), meta.docoId, id);

  const warningFooters = pred.warnings.map((w) => `[🔮 Doco] ⚠️ Authoring warning: ${w.reason}`);
  return Response.json(
    {
      ok: true,
      id,
      name,
      existed: false,
      footer_lines: [`[🔮 Doco] 👤 Principal added: ${name} (${id})`, ...warningFooters],
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
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
  params: { docoHandle: string };
}) {
  const { meta } = await loadDocoRouteForRead(request, params);
  // Two distinct concepts share the URL for historical reasons:
  //
  //   * `principals` (legacy field) — OAuth collaborators of this doco.
  //     Pre-v16 we called them "principals"; the new vocab calls them
  //     "collaborators" but the field name stays for API back-compat.
  //
  //   * `principal_neurons` (new field) — actual Principal neurons in
  //     this doco (role-personas referenced by Action.actor_id,
  //     Intent.actors[], etc.). These are what the BPMN swim-lane view
  //     renders. Agents that want to mutate / list the visible Principal
  //     neurons read this field, not `principals`.
  //
  // `collaborators` is exposed as a clearer alias for the legacy
  // `principals` field — pick whichever name a caller prefers.
  const [docoUsers, neuronRows] = await Promise.all([
    listDocoUsers(meta.docoId),
    listEntitiesByDoco("principal", meta.docoId),
  ]);
  const collaborators = (
    await Promise.all(
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
    )
  ).filter((p) => p !== null);
  const principal_neurons = neuronRows.map((r) => ({
    id: r.id,
    summary: r.summary ?? null,
    lifecycle: r.lifecycle ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
    data: r.data,
    body_md: r.body_md ?? null,
  }));
  return Response.json({
    ok: true,
    principals: collaborators,
    collaborators,
    principal_neurons,
    collaborator_count: collaborators.length,
    principal_neuron_count: principal_neurons.length,
  });
}
