import {
  getCollaboratorById,
  getEntity,
  listDocoUsers,
  listEntitiesByDoco,
  roleAtLeast,
  upsertEntity,
} from "@doco/db";
import { type EntityId, generateUlid, makeEntityId, nowIso } from "@doco/shared";
import { appendAuditEvent } from "~/lib/audit-log.server";
import { runAuthoringPolicies } from "~/lib/authoring-runner.server";
import {
  appendOperationTiming,
  authoringPoliciesPassed,
  reindexAndScheduleAttach,
} from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";

// Footer-line helper: the Principal endpoints used to emit `name (id)`
// as plain text, which the chat surface renders as an unclickable
// 30-character ULID. Mirror what `renderOperationLines` does for
// every other entity — wrap the name in a markdown link to the
// principal's perspective view. The agent pastes the line verbatim,
// the UI renders the markdown, and the user gets a one-click jump
// instead of a raw id.
function principalLinkLabel(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function principalLine(
  emoji: string,
  verb: string,
  name: string,
  id: string,
  request: Request,
  docoHandle: string,
): string {
  const url = `${new URL(request.url).origin}/${docoHandle}/principal/${id}`;
  return `[🔮 Doco] ${emoji} Principal ${verb}: [${principalLinkLabel(name)}](${url})`;
}

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
  const startedAt = performance.now();

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
    body_md?: string;
    reports_to?: string;
  };
  const name = String(body.name ?? "").trim();
  if (!name) {
    return Response.json({ error: "name is required." }, { status: 400 });
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

  const id = makeEntityId("principal", generateUlid()) as EntityId<"principal">;
  const now = nowIso();
  // Migration 037 dropped `summary` from Principal — `body_md` is now
  // the only narrative field. When no body is supplied it stays empty.
  const bodyMd = body.body_md?.trim() || "";
  // `body_md` is included in the candidate so the authoring-policy
  // evaluator sees it. The org-chart template's "person-vs-agent must
  // be declared in body_md" probabilistic gate reads the candidate's
  // body_md field.
  const raw = {
    id,
    doco_id: meta.docoId,
    neuron_type: "principal",
    name,
    body_md: bodyMd,
    ...(body.reports_to ? { reports_to: body.reports_to } : {}),
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
  appendAuditEvent({
    docoDir: docoPath(params.docoHandle),
    docoId: meta.docoId,
    by: me.id,
    entity_type: "principal",
    entity_id: id,
    op: "entity.create",
    after: {
      name,
      body_md: bodyMd,
      lifecycle: "active",
      ...(body.reports_to ? { reports_to: body.reports_to } : {}),
    },
  });

  const warningFooters = pred.warnings.map((w) => `[🔮 Doco] ⚠️ Authoring warning: ${w.reason}`);
  const duration_ms = Math.round(performance.now() - startedAt);
  return Response.json(
    {
      ok: true,
      id,
      name,
      existed: false,
      footer_lines: [
        appendOperationTiming(principalLine("👤", "added", name, id, request, params.docoHandle), {
          duration_ms,
          authoringPoliciesPassed: authoringPoliciesPassed(pred),
        }),
        ...warningFooters,
      ],
      duration_ms,
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
              username: collaboratorDisplayName(c),
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
    name: r.name ?? null,
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

function collaboratorDisplayName(c: Awaited<ReturnType<typeof getCollaboratorById>>): string {
  if (!c) return "";
  const named = c.data.name ?? c.data.display_name;
  if (typeof named === "string" && named.trim()) return named.trim();
  return c.github_login ?? c.id;
}
