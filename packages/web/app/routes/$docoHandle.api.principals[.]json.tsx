import {
  getDocoById,
  getUserById,
  listDocoUsers,
  listEntitiesByDoco,
  roleAtLeast,
  upsertEntity,
} from "@doco/db";
import { BLOCKED_NODE_JSON_EDGE_FIELD_SET, generateUlid, makeEntityId, nowIso } from "@doco/shared";
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

  const { me, meta } = await loadDocoRouteForRead(request, params, "writer");
  if (!me) {
    return Response.json(
      { error: "Authentication required to create a principal." },
      { status: 401 },
    );
  }

  const docoRole = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
  if (!docoRole || !roleAtLeast(docoRole, "writer")) {
    return Response.json(
      { error: "Forbidden: write access required to create a principal." },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    body_md?: string;
    lifecycle?: string;
  };
  for (const [field, value] of Object.entries(body)) {
    if (value !== undefined && value !== null && BLOCKED_NODE_JSON_EDGE_FIELD_SET.has(field)) {
      return Response.json(
        { error: `${field} is not a node JSON field. Create a first-class edge instead.` },
        { status: 400 },
      );
    }
  }
  const name = String(body.name ?? "").trim();
  if (!name) {
    return Response.json({ error: "name is required." }, { status: 400 });
  }

  // Resolve the new Principal's lifecycle. Honors an explicit
  // `lifecycle` (drafting | asserted | retired), then the Doco's
  // template default (`org-chart` ships `drafting`), then `asserted`.
  // Lets a tentative seat be sketched as `drafting`.
  //
  // EXCEPTION — business-processes. There, Principals are swim-lane actors
  // linked from work with `performed_by` edges, and active flow policies only
  // accept non-retired/asserted Principals. Inheriting the template's
  // `drafting` flow-node default would make a freshly-created lane actor fail
  // the next relationship check. Org-chart's draftable seats are about
  // reporting lines, so the inheritance only makes sense there. Default
  // business-processes Principals to `asserted` unless the caller is explicit.
  const VALID_PRINCIPAL_LIFECYCLES = new Set(["drafting", "asserted", "retired"]);
  let lifecycle = "asserted";
  if (body.lifecycle !== undefined) {
    if (typeof body.lifecycle !== "string" || !VALID_PRINCIPAL_LIFECYCLES.has(body.lifecycle)) {
      return Response.json(
        { error: "lifecycle must be one of: drafting, asserted, retired." },
        { status: 400 },
      );
    }
    lifecycle = body.lifecycle;
  } else {
    const doco = await getDocoById(meta.docoId);
    const templateHandle =
      typeof doco?.data?.template_handle === "string" ? doco.data.template_handle : null;
    const dflt = doco?.default_node_lifecycle;
    // Skip the drafting inheritance for business-processes (see above) —
    // its lane actors must be resolvable the moment they're created.
    if (templateHandle !== "business-processes" && dflt && VALID_PRINCIPAL_LIFECYCLES.has(dflt)) {
      lifecycle = dflt;
    }
  }

  const id = makeEntityId("principal", generateUlid());
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
    node_type: "principal",
    name,
    body_md: bodyMd,
    created_at: now,
    created_by: me.id,
    lifecycle,
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
    lifecycle,
    created_at: now,
    created_by: me.id,
    updated_at: now,
    updated_by: me.id,
  });

  // Reindex so FTS and embeddings reflect the new Principal. Other capture
  // routes do this via the generic capture factory; principals use a bespoke
  // handler and need to call the helper directly.
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
      lifecycle,
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
    listEntitiesByDoco("principal", meta.docoId),
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
    name: r.name ?? null,
    lifecycle: r.lifecycle ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
    data: r.data,
    body_md: r.body_md ?? null,
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
