import { getEntity, roleAtLeast, upsertEntity, withClient } from "@doco/db";
import { type EntityId, nowIso } from "@doco/shared";
import { runAuthoringPolicies } from "~/lib/authoring-runner.server";
import { reindexAndScheduleAttach } from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { getDocoLevelRole, loadDocoRouteForRead } from "~/lib/doco-access.server";

// Principal is a Record per the "frozen claims, mutable records"
// Decision (decision_01KRKEPRAMM9QSSEJ2X5FHPESJ). The only identity
// field locked in place is `name` — it's the lookup slug other
// neurons and prose mention by hand, so changing it would silently
// break callers. Everything else on the Record (summary, body_md,
// reports_to, lifecycle) is editable.
const PATCHABLE_KEYS = new Set(["body_md", "summary", "reports_to", "lifecycle"]);

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
  body_md?: string;
  summary?: string;
  /** `null` clears the synapse (Principal becomes top-of-chain). */
  reports_to?: string | null;
  /** Only `"retired"` is accepted; the lifecycle path is one-way. */
  lifecycle?: "retired";
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

  let rawPatch: Record<string, unknown>;
  try {
    rawPatch = (await request.json()) as Record<string, unknown>;
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }
  if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
    return Response.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  // Reject unknown keys up-front so typos don't silently no-op. `name`
  // is intentionally absent from PATCHABLE_KEYS — it's the slug other
  // neurons reference, so it stays immutable.
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
  if (patch.reports_to !== undefined && patch.reports_to !== null) {
    if (typeof patch.reports_to !== "string" || !patch.reports_to.startsWith("principal_")) {
      return Response.json(
        { error: "reports_to must be a principal id (principal_<ULID>) or null to clear." },
        { status: 400 },
      );
    }
    if (patch.reports_to === params.id) {
      return Response.json(
        { error: "reports_to cannot point at the Principal itself." },
        { status: 400 },
      );
    }
    const manager = await getEntity("principal", patch.reports_to as EntityId<"principal">);
    if (!manager || manager.doco_id !== meta.docoId) {
      return Response.json(
        { error: `reports_to principal not found in this Doco: ${patch.reports_to}` },
        { status: 400 },
      );
    }
  }

  const existing = await getEntity("principal", params.id);
  if (!existing || existing.doco_id !== meta.docoId) {
    return Response.json({ error: `principal not found: ${params.id}` }, { status: 404 });
  }
  const name = String(existing.data?.name ?? existing.id);

  // Retirement path: lifecycle="retired" goes through the active-refs
  // guard. Field edits in the same patch are applied alongside the
  // lifecycle flip when the guard passes.
  if (patch.lifecycle === "retired") {
    if (existing.lifecycle === "retired") {
      return Response.json({
        ok: true,
        id: existing.id,
        already_retired: true,
        footer_lines: [principalLine("already retired", name, existing.id, request, params.docoHandle)],
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
  }

  // Build the merged data object. `reports_to: null` clears the synapse;
  // `undefined` (key absent from patch) leaves the existing value alone.
  const oldData = (existing.data ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...oldData };
  if (patch.summary !== undefined) merged.summary = patch.summary.trim();
  if (patch.reports_to === null) {
    // Remove the key entirely so `deriveSynapses` doesn't see it and
    // doesn't emit a `reports_to` synapse — promotes the Principal
    // back to top-of-chain.
    // biome-ignore lint/performance/noDelete: removing the key (not setting undefined) keeps the data JSONB clean and lets downstream `toHaveProperty` assertions stay honest.
    delete merged.reports_to;
  } else if (patch.reports_to !== undefined) {
    merged.reports_to = patch.reports_to;
  }
  const nextLifecycle = patch.lifecycle ?? (existing.lifecycle as string | undefined) ?? "active";
  merged.lifecycle = nextLifecycle;

  const nextBodyMd =
    patch.body_md !== undefined ? (patch.body_md ?? "") : (existing.body_md ?? undefined);
  const nextSummary =
    patch.summary !== undefined ? (merged.summary as string) : (existing.summary ?? undefined);

  // Surface `body_md` to the policy evaluator. It lives on its own
  // text column on principals (not inside the data jsonb), so the
  // merged-from-data candidate would miss it — the org-chart
  // template's "declare person-vs-agent in body_md" probabilistic
  // gate would then reject every PATCH that didn't supply a fresh
  // body_md, even when the existing body already declared it.
  merged.body_md = nextBodyMd ?? "";

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
    summary: nextSummary,
    body_md: nextBodyMd,
    lifecycle: nextLifecycle,
    created_at: existing.created_at ?? undefined,
    created_by: existing.created_by ?? undefined,
    updated_at: now,
    updated_by: me.id,
  });

  await reindexAndScheduleAttach(docoPath(params.docoHandle), meta.docoId, existing.id);

  const warningFooters = pred.warnings.map((w) => `[🔮 Doco] ⚠️ Authoring warning: ${w.reason}`);
  if (patch.lifecycle === "retired") {
    return Response.json({
      ok: true,
      id: existing.id,
      lifecycle: "retired",
      footer_lines: [
        principalLine("retired", name, existing.id, request, params.docoHandle),
        ...warningFooters,
      ],
      ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
    });
  }
  return Response.json({
    ok: true,
    id: existing.id,
    lifecycle: nextLifecycle,
    footer_lines: [
      principalLine("updated", name, existing.id, request, params.docoHandle),
      ...warningFooters,
    ],
    ...(pred.warnings.length > 0 ? { warnings: pred.warnings } : {}),
  });
}
