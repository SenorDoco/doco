import { getEntity, roleAtLeast, upsertEntity, withClient } from "@doco/db";
import { nowIso } from "@doco/shared";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";

interface PrincipalPatch {
  lifecycle?: string;
}

interface ActiveReference {
  id: string;
  neuron_type: string;
  summary: string | null;
  synapse_type: string;
}

// Find every active neuron in this Doco that references the principal.
// Targets the three currently-known principal-shaped reference fields:
//   Action.actor_id, Log.actor_id, Intent.{stakeholders, actors}
// Synapses materialize all of these, so a single UNION across the
// referencing tables is enough — no per-row N+1 lookup.
async function findActiveReferencesToPrincipal(
  docoId: string,
  principalId: string,
): Promise<ActiveReference[]> {
  return withClient(async (c) => {
    const sql = `
      SELECT a.id AS id, 'action'::text AS neuron_type, split_part(a.action, E'\n', 1) AS summary, s.synapse_type AS synapse_type
        FROM actions a
        JOIN synapses s
          ON s.from_id = a.id
         AND s.from_neuron_type = 'action'
       WHERE s.doco_id = $1 AND s.to_id = $2 AND a.lifecycle = 'active'
      UNION ALL
      SELECT l.id, 'log'::text, split_part(l.log, E'\n', 1), s.synapse_type
        FROM logs l
        JOIN synapses s
          ON s.from_id = l.id
         AND s.from_neuron_type = 'log'
       WHERE s.doco_id = $1 AND s.to_id = $2 AND l.lifecycle = 'active'
      UNION ALL
      SELECT i.id, 'intent'::text, split_part(i.intent, E'\n', 1), s.synapse_type
        FROM intents i
        JOIN synapses s
          ON s.from_id = i.id
         AND s.from_neuron_type = 'intent'
       WHERE s.doco_id = $1 AND s.to_id = $2 AND i.lifecycle = 'active'
      ORDER BY neuron_type, id`;
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
      summary: existing.summary,
      ...existing.data,
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
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  const { me, meta } = await loadDocoRouteForRead(request, params, "author");
  if (!me) {
    return Response.json({ error: "Authentication required to edit." }, { status: 401 });
  }
  const docoRole = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
  if (!roleAtLeast(docoRole, "author")) {
    return Response.json(
      { error: "Forbidden: author role required to edit a principal." },
      { status: 403 },
    );
  }

  let patch: PrincipalPatch;
  try {
    patch = (await request.json()) as PrincipalPatch;
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }

  // Retirement is the only PATCH operation currently supported. Principal
  // identity fields (name, display_name, …) stay immutable — if you
  // need a different identity, create a new principal.
  if (patch.lifecycle !== "retired") {
    return Response.json(
      { error: "Only { lifecycle: 'retired' } is supported on principal PATCH." },
      { status: 400 },
    );
  }

  const existing = await getEntity("principal", params.id);
  if (!existing || existing.doco_id !== meta.docoId) {
    return Response.json({ error: `principal not found: ${params.id}` }, { status: 404 });
  }

  const name = String(existing.data?.name ?? existing.id);

  if (existing.lifecycle === "retired") {
    return Response.json({
      ok: true,
      id: existing.id,
      already_retired: true,
      footer_lines: [`[🔮 Doco] 👤 Principal already retired: ${name} (${existing.id})`],
    });
  }

  const activeRefs = await findActiveReferencesToPrincipal(meta.docoId, params.id);
  if (activeRefs.length > 0) {
    return Response.json(
      {
        error:
          "Cannot retire principal: active neurons still reference it. Retire or supersede those neurons first.",
        active_references: activeRefs,
      },
      { status: 409 },
    );
  }

  const now = nowIso();
  const newData = { ...existing.data, lifecycle: "retired" };
  await upsertEntity({
    id: existing.id,
    doco_id: existing.doco_id,
    entity_type: "principal",
    data: newData,
    summary: existing.summary ?? undefined,
    body_md: existing.body_md ?? undefined,
    lifecycle: "retired",
    created_at: existing.created_at ?? undefined,
    created_by: existing.created_by ?? undefined,
    updated_at: now,
    updated_by: me.id,
  });

  return Response.json({
    ok: true,
    id: existing.id,
    lifecycle: "retired",
    footer_lines: [`[🔮 Doco] 👤 Principal retired: ${name} (${existing.id})`],
  });
}
