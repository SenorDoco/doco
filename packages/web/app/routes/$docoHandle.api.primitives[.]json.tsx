// GET/POST /<doco-handle>/api/primitives.json — dedicated primitives endpoint.
//
// Primitives (`guidance_primitive`, `neuron_authoring_primitive`) are not
// neurons. They are Doco-level metadata and are *only* reachable from
// this endpoint, the agent bootstrap response, or the HTML primitives
// page. The generic /<handle>/api/<type>.json dispatcher refuses
// primitive types.
//
// GET  → list every primitive in the Doco, both kinds, with a
//        `primitive_kind` discriminator.
// POST → capture a new primitive. Body shape:
//        { "primitive_kind": "guidance" | "neuron_authoring", ...draft }
//        Where `...draft` follows GuidancePrimitiveDraft or
//        NeuronAuthoringPrimitiveDraft from capture.server.ts.

import { roleAtLeast, withClient } from "@doco/db";
import {
  type GuidancePrimitiveDraft,
  type NeuronAuthoringPrimitiveDraft,
  captureGuidancePrimitive,
  captureNeuronAuthoringPrimitive,
} from "~/lib/capture.server";
import {
  type DocoRouteParams,
  getDocoLevelRole,
  loadDocoRouteForRead,
} from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";

interface PrimitiveRow {
  id: string;
  summary: string;
  lifecycle: string | null;
  body_md: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface PrimitiveListEntry extends PrimitiveRow {
  primitive_kind: "guidance" | "neuron_authoring";
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams;
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  return withClient(async (c) => {
    const [guidance, neuronAuthoring] = await Promise.all([
      c.query<PrimitiveRow>(
        `SELECT id, summary, lifecycle, body_md,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM guidance_primitives
          WHERE doco_id = $1
          ORDER BY created_at DESC`,
        [ctx.meta.docoId],
      ),
      c.query<PrimitiveRow>(
        `SELECT id, summary, lifecycle, body_md,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM neuron_authoring_primitives
          WHERE doco_id = $1
          ORDER BY created_at DESC`,
        [ctx.meta.docoId],
      ),
    ]);
    const items: PrimitiveListEntry[] = [
      ...guidance.rows.map((r) => ({
        ...r,
        primitive_kind: "guidance" as const,
      })),
      ...neuronAuthoring.rows.map((r) => ({
        ...r,
        primitive_kind: "neuron_authoring" as const,
      })),
    ];
    return Response.json({
      doco_id: ctx.meta.docoId,
      doco_handle: ctx.handle,
      count: items.length,
      guidance_count: guidance.rows.length,
      neuron_authoring_count: neuronAuthoring.rows.length,
      items,
    });
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams;
}) {
  const { dir, docoSlug, me, meta, ownerSlug } = await loadDocoRouteForRead(
    request,
    params,
    "author",
  );
  if (!me) {
    return Response.json({ error: "Authentication required to write." }, { status: 401 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  const bodyText = await request.text();

  return withIdempotency(request, "POST /api/primitives", me.id ?? null, bodyText, async () => {
    let parsed: { primitive_kind?: unknown } & Record<string, unknown>;
    try {
      parsed = JSON.parse(bodyText);
    } catch (e) {
      return Response.json(
        { error: `Invalid JSON body: ${(e as Error).message}` },
        { status: 400 },
      );
    }
    const primitiveKind = parsed.primitive_kind;
    if (primitiveKind !== "guidance" && primitiveKind !== "neuron_authoring") {
      return Response.json(
        {
          error:
            'Body must include "primitive_kind": "guidance" | "neuron_authoring" to disambiguate.',
        },
        { status: 400 },
      );
    }

    const docoRole = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
    if (!docoRole || !roleAtLeast(docoRole, "author")) {
      return Response.json({ error: "Forbidden: author role required to write." }, { status: 403 });
    }

    const docoHost = new URL(request.url).origin;
    const { primitive_kind: _discarded, ...rest } = parsed;

    if (primitiveKind === "guidance") {
      const draft = rest as unknown as GuidancePrimitiveDraft;
      if (!draft.authored_by_username) draft.authored_by_username = me.username;
      if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
      const result = await captureGuidancePrimitive(
        dir,
        meta.docoId,
        ownerSlug,
        docoSlug,
        draft,
        docoHost,
      );
      if ("error" in result) return Response.json(result, { status: 400 });
      return Response.json(result, { status: 201 });
    }

    const draft = rest as unknown as NeuronAuthoringPrimitiveDraft;
    if (!draft.authored_by_username) draft.authored_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
    const result = await captureNeuronAuthoringPrimitive(
      dir,
      meta.docoId,
      ownerSlug,
      docoSlug,
      draft,
      docoHost,
    );
    if ("error" in result) return Response.json(result, { status: 400 });
    return Response.json(result, { status: 201 });
  });
}
