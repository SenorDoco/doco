// POST /<owner>/<doco>/api/admin/apply-template-updates.json
//
// One-shot admin endpoint that brings the target Doco's managed scopes
// (currently `global` and `user-flows`) into alignment with the current
// DEFAULT_SCOPE_TEMPLATES per decision_01KRRD6QM7NN2EV56NZK96DNKY.
//
// Idempotent: seeds only missing rules, abandons only known-stale
// summaries, and refreshes the user-flows seed Intent's summary only if
// it matches a known prior value. Re-running is a no-op once a Doco is
// up to date.
//
// Admin-only — gated by `loadDocoForAdmin`.

import { applyScopeTemplateUpdatesToDoco } from "@doco/host";
import type { EntityId } from "@doco/shared";
import { loadDocoForAdmin } from "~/lib/doco-access.server";

export function loader() {
  return Response.json(
    {
      error:
        "POST to this endpoint to apply template updates. No body required. Admin only.",
    },
    { status: 405 },
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ error: "POST required." }, { status: 405 });
  }
  const { ownerSlug, docoSlug } = params;
  const { meta, me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const result = await applyScopeTemplateUpdatesToDoco({
    docoId: meta.docoId as EntityId<"doco">,
    createdBy: (me?.id as EntityId<"principal"> | undefined) ?? null,
  });
  return Response.json({
    ok: true,
    doco_id: meta.docoId,
    ...result,
  });
}
