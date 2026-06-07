import { getEntity, upsertEntity, withClient } from "@doco/db";
import { BLOCKED_NODE_JSON_EDGE_FIELD_SET, nowIso } from "@doco/shared";
import { appendAuditEvent } from "~/lib/audit-log.server";
import { runAuthoringPolicies } from "~/lib/authoring-runner.server";
import {
  appendOperationTiming,
  authoringPoliciesPassed,
  reindexAndScheduleAttach,
} from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { loadDocoRouteForRead, requireDocoTypeWriteForRequest } from "~/lib/doco-access.server";

// Principals keep a small positive patch allowlist: name, lifecycle.
// `name` is editable — renames are recorded in the audit log, and other nodes
// reference principals by id (not name), so a rename never breaks edges; only
// hand-written prose mentions go stale.
const PATCHABLE_KEYS = new Set(["name", "lifecycle"]);

// Mirror principalLine in /api/principals.json.tsx — wrap the name
// in a markdown link to the principal's perspective view so the chat
// surface gets a clickable jump instead of a raw 30-char ULID.
function principalLine(
  verb: string,
  name: string,
  id: string,
  request: Request,
  docoHandle: string,
): string {
  const url = `${new URL(request.url).origin}/${docoHandle}/principal/${id}`;
  return `[🔮 Doco] 👤 Principal ${verb}: [${name}](${url})`;
}

interface PrincipalPatch {
  /** Display name. Trimmed before storage; must be non-empty. Not required to be unique. */
  name?: string;
  /** Only `"retired"` is accepted; the lifecycle path is one-way. */
  lifecycle?: "retired";
}

interface ActiveReference {
  id: string;
  node_type: string;
  summary: string | null;
  edge_type: string;
}

// Find every active node in this Doco that references the principal through an
// edge, so retirement can only proceed after dependent nodes are retired or
// rewired.
async function findActiveReferencesToPrincipal(
  docoId: string,
  principalId: string,
): Promise<ActiveReference[]> {
  return withClient(async (c) => {
    // Post-collapse: Action / Log / Intent all live in `nodes`. Their
    // prose lives in the shared `prose` column; the per-leg node_type
    // discriminator replaces the per-table FROM.
    const sql = `
      SELECT a.id AS id, 'action'::text AS node_type, split_part(a.prose, E'\n', 1) AS summary, s.edge_type AS edge_type
        FROM nodes a
        JOIN edges s
          ON s.from_id = a.id
         AND s.from_node_type = 'action'
       WHERE a.node_type = 'action' AND s.doco_id = $1 AND s.to_id = $2 AND a.lifecycle = 'active'
      UNION ALL
      SELECT l.id, 'log'::text, split_part(l.prose, E'\n', 1), s.edge_type
        FROM nodes l
        JOIN edges s
          ON s.from_id = l.id
         AND s.from_node_type = 'log'
       WHERE l.node_type = 'log' AND s.doco_id = $1 AND s.to_id = $2 AND l.lifecycle = 'active'
      UNION ALL
      SELECT i.id, 'intent'::text, split_part(i.prose, E'\n', 1), s.edge_type
        FROM nodes i
        JOIN edges s
          ON s.from_id = i.id
         AND s.from_node_type = 'intent'
       WHERE i.node_type = 'intent' AND s.doco_id = $1 AND s.to_id = $2 AND i.lifecycle = 'active'
      ORDER BY node_type, id`;
    const r = await c.query<ActiveReference>(sql, [docoId, principalId]);
    return r.rows;
  });
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string; id: string };
}) {
  const { meta } = await loadDocoRouteForRead(request, params);
  const existing = await getEntity("principal", params.id);
  if (!existing || existing.doco_id !== meta.docoId) {
    return Response.json({ error: `principal not found: ${params.id}` }, { status: 404 });
  }
  return Response.json({
    ok: true,
    principal: {
      id: existing.id,
      doco_id: existing.doco_id,
      lifecycle: existing.lifecycle,
      // A principal's name is its `prose`; its seat kind and domain fields
      // (owner_id, …) ride in `extra`.
      name: existing.prose,
      ...(existing.kind != null ? { kind: existing.kind } : {}),
      ...existing.extra,
      created_at: existing.created_at,
      created_by: existing.created_by,
      updated_at: existing.updated_at,
      updated_by: existing.updated_by,
    },
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string; id: string };
}) {
  if (request.method !== "PATCH" && request.method !== "POST") {
    return Response.json({ error: "Use PATCH or POST." }, { status: 405 });
  }
  const startedAt = performance.now();
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  const { me, meta } = await loadDocoRouteForRead(request, params, "reader");
  if (!me) {
    return Response.json({ error: "Authentication required to edit." }, { status: 401 });
  }
  const denied = await requireDocoTypeWriteForRequest(
    request,
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
    "principal",
    "edit a principal",
  );
  if (denied) return denied;

  let rawPatch: Record<string, unknown>;
  try {
    rawPatch = (await request.json()) as Record<string, unknown>;
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
    return Response.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  for (const field of Object.keys(rawPatch)) {
    if (BLOCKED_NODE_JSON_EDGE_FIELD_SET.has(field)) {
      return Response.json(
        {
          error: `${field} is not a node JSON field. Create, update, or retire a first-class edge instead.`,
        },
        { status: 400 },
      );
    }
  }

  // Reject unknown keys up-front so typos don't silently no-op.
  const unknown = Object.keys(rawPatch).filter((k) => !PATCHABLE_KEYS.has(k));
  if (unknown.length > 0) {
    return Response.json(
      {
        error: `Unknown or immutable field(s) in patch: ${unknown.join(", ")}. Allowed: ${[...PATCHABLE_KEYS].join(", ")}.`,
      },
      { status: 400 },
    );
  }
  if (Object.keys(rawPatch).length === 0) {
    return Response.json(
      { error: `Empty patch; supply at least one of: ${[...PATCHABLE_KEYS].join(", ")}.` },
      { status: 400 },
    );
  }
  const patch = rawPatch as PrincipalPatch;

  if (patch.lifecycle !== undefined && patch.lifecycle !== "retired") {
    return Response.json(
      { error: 'lifecycle must be "retired" — the only lifecycle transition supported on PATCH.' },
      { status: 400 },
    );
  }
  if (patch.name !== undefined && (typeof patch.name !== "string" || patch.name.trim() === "")) {
    return Response.json({ error: "name must be a non-empty string." }, { status: 400 });
  }

  const existing = await getEntity("principal", params.id);
  if (!existing || existing.doco_id !== meta.docoId) {
    return Response.json({ error: `principal not found: ${params.id}` }, { status: 404 });
  }
  const name = patch.name !== undefined ? patch.name.trim() : existing.prose || existing.id;

  // Retirement path: lifecycle="retired" goes through the active-refs
  // guard. Field edits in the same patch are applied alongside the
  // lifecycle flip when the guard passes.
  if (patch.lifecycle === "retired") {
    if (existing.lifecycle === "retired") {
      const duration_ms = Math.round(performance.now() - startedAt);
      return Response.json({
        ok: true,
        id: existing.id,
        already_retired: true,
        footer_lines: [
          appendOperationTiming(
            principalLine("already retired", name, existing.id, request, params.docoHandle),
            {
              duration_ms,
              authoringPoliciesPassed: 0,
            },
          ),
        ],
        duration_ms,
      });
    }
    const activeRefs = await findActiveReferencesToPrincipal(meta.docoId, params.id);
    if (activeRefs.length > 0) {
      return Response.json(
        {
          error:
            "Cannot retire principal: active nodes still reference it. Retire or supersede those nodes first.",
          active_references: activeRefs,
        },
        { status: 409 },
      );
    }
  }

  // Build the merged write bag from the honest node row. Relation changes are
  // represented by edge creates/updates/retirements, not by patching Principal
  // JSON. A principal's name is its `prose`.
  const oldData: Record<string, unknown> = {
    id: existing.id,
    doco_id: existing.doco_id,
    node_type: existing.node_type,
    prose: existing.prose,
    ...existing.extra,
  };
  if (existing.kind != null) oldData.kind = existing.kind;
  const merged: Record<string, unknown> = { ...oldData };
  const nextLifecycle = patch.lifecycle ?? existing.lifecycle ?? "active";
  merged.lifecycle = nextLifecycle;
  if (patch.name !== undefined) {
    merged.prose = patch.name.trim();
  }

  // Run authoring policies against the merged candidate so org-chart
  // templates can block transitions that would leave the Principal in
  // an invalid state. Field updates use the same evaluator that the
  // POST route runs.
  const pred = await runAuthoringPolicies({
    docoId: meta.docoId,
    candidate: merged as Parameters<typeof runAuthoringPolicies>[0]["candidate"],
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

  const now = nowIso();
  await upsertEntity({
    id: existing.id,
    doco_id: existing.doco_id,
    entity_type: "principal",
    data: merged,
    lifecycle: nextLifecycle,
    created_at: existing.created_at ?? undefined,
    created_by: existing.created_by ?? undefined,
    updated_at: now,
    updated_by: me.id,
  });

  await reindexAndScheduleAttach(docoPath(params.docoHandle), meta.docoId, existing.id);
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  if (patch.lifecycle !== undefined && patch.lifecycle !== existing.lifecycle) {
    before.lifecycle = existing.lifecycle ?? "active";
    after.lifecycle = nextLifecycle;
  }
  if (patch.name !== undefined) {
    before.name = existing.prose || null;
    after.name = merged.prose;
  }
  appendAuditEvent({
    docoDir: docoPath(params.docoHandle),
    docoId: meta.docoId,
    by: me.id,
    entity_type: "principal",
    entity_id: existing.id,
    op: patch.lifecycle !== undefined ? "lifecycle.transition" : "entity.update",
    before,
    after,
  });

  const warningFooters = pred.warnings.map((w) => `[🔮 Doco] ⚠️ Authoring warning: ${w.reason}`);
  const duration_ms = Math.round(performance.now() - startedAt);
  if (patch.lifecycle === "retired") {
    return Response.json({
      ok: true,
      id: existing.id,
      lifecycle: "retired",
      footer_lines: [
        appendOperationTiming(
          principalLine("retired", name, existing.id, request, params.docoHandle),
          {
            duration_ms,
            authoringPoliciesPassed: authoringPoliciesPassed(pred),
          },
        ),
        ...warningFooters,
      ],
      duration_ms,
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    });
  }
  return Response.json({
    ok: true,
    id: existing.id,
    lifecycle: nextLifecycle,
    footer_lines: [
      appendOperationTiming(
        principalLine("updated", name, existing.id, request, params.docoHandle),
        {
          duration_ms,
          authoringPoliciesPassed: authoringPoliciesPassed(pred),
        },
      ),
      ...warningFooters,
    ],
    duration_ms,
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  });
}
