// GET/POST /<doco-handle>/api/policies.json — dedicated policies endpoint.
//
// Policies (`guidance_policy`, `neuron_authoring_policy`) are not
// neurons. They are Doco-level metadata and are *only* reachable from
// this endpoint, the agent bootstrap response, or the HTML policies
// page. The generic /<handle>/api/<type>.json dispatcher refuses
// policy types.
//
// GET  → list every policy in the Doco, both kinds, with a
//        `policy_kind` discriminator.
// POST → capture a new policy. Body shape:
//        { "policy_kind": "guidance" | "neuron_authoring", ...draft }
//        Where `...draft` follows GuidancePolicyDraft or
//        NeuronAuthoringPolicyDraft from capture.server.ts.

import { withClient } from "@doco/db";
import {
  type GuidancePolicyDraft,
  type NeuronAuthoringPolicyDraft,
  captureGuidancePolicy,
  captureNeuronAuthoringPolicy,
} from "~/lib/capture.server";
import {
  type DocoRouteParams,
  getDocoLevelRole,
  loadDocoRouteForRead,
} from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";
import { resolvePrincipalIdForCollaborator } from "~/lib/principal-collaborator.server";

interface PolicyRow {
  id: string;
  policy: string;
  lifecycle: string | null;
  body_md: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface PolicyListEntry extends PolicyRow {
  policy_kind: "guidance" | "neuron_authoring";
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
      c.query<PolicyRow>(
        `SELECT id, policy, lifecycle, body_md,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM guidance_policies
          WHERE doco_id = $1
          ORDER BY created_at DESC`,
        [ctx.meta.docoId],
      ),
      c.query<PolicyRow>(
        `SELECT id, policy, lifecycle, body_md,
                created_at::text AS created_at,
                updated_at::text AS updated_at
           FROM neuron_authoring_policies
          WHERE doco_id = $1
          ORDER BY created_at DESC`,
        [ctx.meta.docoId],
      ),
    ]);
    const items: PolicyListEntry[] = [
      ...guidance.rows.map((r) => ({
        ...r,
        policy_kind: "guidance" as const,
      })),
      ...neuronAuthoring.rows.map((r) => ({
        ...r,
        policy_kind: "neuron_authoring" as const,
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
    "owner",
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

  return withIdempotency(request, "POST /api/policies", me.id ?? null, bodyText, async () => {
    let parsed: { policy_kind?: unknown } & Record<string, unknown>;
    try {
      parsed = JSON.parse(bodyText);
    } catch (e) {
      return Response.json(
        { error: `Invalid JSON body: ${(e as Error).message}` },
        { status: 400 },
      );
    }
    const policyKind = parsed.policy_kind;
    if (policyKind !== "guidance" && policyKind !== "neuron_authoring") {
      return Response.json(
        {
          error:
            'Body must include "policy_kind": "guidance" | "neuron_authoring" to disambiguate.',
        },
        { status: 400 },
      );
    }

    const docoRole = await getDocoLevelRole({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
    if (docoRole !== "owner") {
      return Response.json(
        { error: "Forbidden: owner role required to write policies." },
        { status: 403 },
      );
    }

    const docoHost = new URL(request.url).origin;
    const { policy_kind: _discarded, ...rest } = parsed;

    if (policyKind === "guidance") {
      const draft = rest as unknown as GuidancePolicyDraft;
      if (!draft.authored_by_principal_id && me.id) {
        draft.authored_by_principal_id =
          (await resolvePrincipalIdForCollaborator(meta.docoId, me.id)) ?? undefined;
      }
      if (me.id) draft.created_by_collaborator_id = me.id;
      const result = await captureGuidancePolicy(
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

    const draft = rest as unknown as NeuronAuthoringPolicyDraft;
    if (!draft.authored_by_principal_id && me.id) {
      draft.authored_by_principal_id =
        (await resolvePrincipalIdForCollaborator(meta.docoId, me.id)) ?? undefined;
    }
    if (me.id) draft.created_by_collaborator_id = me.id;
    const result = await captureNeuronAuthoringPolicy(
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
