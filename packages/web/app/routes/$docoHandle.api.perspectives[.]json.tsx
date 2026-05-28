// /<doco-handle>/api/perspectives.json — read + mutate the
// perspectives attached to this Doco.
//
// GET (loader):
//   {
//     attached:  AttachedPerspective[]   // tabs in order
//     available: Perspective[]           // for the picker page
//     can_admin: boolean                 // canApproveDoco()
//   }
//
// POST (action):
//   Form body (application/x-www-form-urlencoded or JSON):
//     _action: "attach" | "detach" | "set_default"
//     perspective_id: <id>
//
//   200 -> { ok: true }
//   400 -> { ok: false, error: "<reason>" }
//   403 -> { ok: false, error: "forbidden" }
//
// Gating: GET follows the Doco's read gate. POST requires
// canApproveDoco() (owner or approver), per the spec.

import { canApproveDoco, loadDocoRouteForRead } from "~/lib/doco-access.server";
import {
  attachPerspectiveToDoco,
  detachPerspectiveFromDoco,
  listAvailablePerspectives,
  listPerspectivesForDoco,
  setDefaultPerspective,
} from "~/lib/perspectives.server";

type ActionKind = "attach" | "detach" | "set_default";
const ACTION_KINDS: ReadonlySet<ActionKind> = new Set(["attach", "detach", "set_default"]);

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { meta, me } = await loadDocoRouteForRead(request, params);
  const [attached, available, canAdmin] = await Promise.all([
    listPerspectivesForDoco(meta.docoId),
    listAvailablePerspectives(),
    canApproveDoco(meta, me?.id ?? null),
  ]);
  return Response.json({ attached, available, can_admin: canAdmin });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  const { meta, me } = await loadDocoRouteForRead(request, params);
  if (!me) {
    return Response.json({ ok: false, error: "anonymous_forbidden" }, { status: 403 });
  }
  if (!(await canApproveDoco(meta, me.id))) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const body = await readBody(request);
  const actionKind = body._action;
  if (!actionKind || !ACTION_KINDS.has(actionKind as ActionKind)) {
    return Response.json({ ok: false, error: "invalid_action" }, { status: 400 });
  }
  const perspectiveId = body.perspective_id;
  if (typeof perspectiveId !== "string" || perspectiveId.length === 0) {
    return Response.json({ ok: false, error: "missing_perspective_id" }, { status: 400 });
  }

  switch (actionKind as ActionKind) {
    case "attach": {
      await attachPerspectiveToDoco({
        docoId: meta.docoId,
        perspectiveId,
        attachedByUserId: me.id,
      });
      return Response.json({ ok: true });
    }
    case "detach": {
      const result = await detachPerspectiveFromDoco({
        docoId: meta.docoId,
        perspectiveId,
      });
      if (!result.ok) {
        return Response.json({ ok: false, error: result.error }, { status: 400 });
      }
      return Response.json({ ok: true });
    }
    case "set_default": {
      const result = await setDefaultPerspective({
        docoId: meta.docoId,
        perspectiveId,
      });
      if (!result.ok) {
        return Response.json({ ok: false, error: result.error }, { status: 400 });
      }
      return Response.json({ ok: true });
    }
  }
}

async function readBody(request: Request): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = (await request.json()) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }
  const form = await request.formData();
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
