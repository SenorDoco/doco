// Per-entity capture endpoint — single dispatcher for all `simple capture`
// entity types. Adding a new entity type means adding a row to
// CAPTURE_REGISTRY below; no new route file required.
//
// Special-cased routes that need custom logic (e.g. /api/decisions/<id>
// with ADR promotion, /api/principals with role-principal seeding,
// /api/invites, /api/settings, /api/audit) keep their dedicated route
// files and win the match by being more specific in routes.ts.
//
// GET behaviour: returns a list of every neuron of the named type
// for this doco. Originally this loader returned a 405 telling the
// caller to POST, but the agent (and external scripts) want a real
// list endpoint per type. The list response shape is uniform across
// types so consumers can iterate without per-type branching:
//   { ok: true, type: "<plural>", doco_id, count, items: [...] }

import { listEntitiesByDoco, listPrincipals } from "@doco/db";
import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import {
  type ActionDraft,
  type DecisionDraft,
  type EvalDraft,
  type IdeaDraft,
  type IntentDraft,
  type LogDraft,
  type ReferenceDraft,
  type RuleDraft,
  type StateDraft,
  captureAction,
  captureDecision,
  captureEval,
  captureIdea,
  captureIntent,
  captureLog,
  captureReference,
  captureRule,
  captureState,
} from "~/lib/capture.server";
import { type DocoRouteParams, loadDocoRouteForRead } from "~/lib/doco-access.server";

interface MeLike {
  id: string | null;
  username: string;
}

/**
 * Resolve the authenticated collaborator to a Principal NEURON id in
 * this doco. *_principal_id columns reference principals.id and
 * actively reject collaborator_* values, so we can't just stamp
 * `me.id` (which is a collaborator id) into them. Preference order:
 *
 *   1. A principal whose `data.created_by` is this collaborator OR
 *      whose `data.owner_id` references them. Captures the case
 *      where the user explicitly created a role-persona for
 *      themselves.
 *   2. The "user" role-principal in this doco (the well-known
 *      generic role every signed-in human plays by default).
 *   3. The "human" role-principal as a secondary fallback.
 *
 * Returns null when nothing matches — the validator downstream will
 * then surface a clear "this field is required" error with a
 * pointer to /api/principals.json.
 *
 * Cached per-(docoId, collaboratorId) for the lifetime of the
 * process — principals are not added often, and any miss falls
 * through to a fresh `listPrincipals` query.
 */
const principalForCollaboratorCache = new Map<string, string>();
async function resolvePrincipalIdForCollaborator(
  docoId: string,
  collaboratorId: string,
): Promise<string | null> {
  const key = `${docoId}:${collaboratorId}`;
  const cached = principalForCollaboratorCache.get(key);
  if (cached) return cached;
  const rows = await listPrincipals(docoId);
  const own = rows.find((r) => {
    const data = r.data ?? {};
    return (
      (typeof data.created_by === "string" && data.created_by === collaboratorId) ||
      (typeof data.owner_id === "string" && data.owner_id === collaboratorId)
    );
  });
  const role = rows.find((r) => r.name === "user") ?? rows.find((r) => r.name === "human") ?? null;
  const pick = own ?? role;
  if (!pick) return null;
  principalForCollaboratorCache.set(key, pick.id);
  return pick.id;
}

/**
 * Self-healing reconciliation of every `*_principal_id` field on the
 * draft. Two failure modes the validator otherwise rejects:
 *
 *   1. Field missing → fill with the calling user's resolved
 *      principal (the same "auth defaults" PR #151 already did).
 *
 *   2. Field present but holds a `collaborator_*` id → resolve THAT
 *      collaborator to its principal in this doco. Covers the case
 *      where the agent (or any other API caller) reads its own
 *      `me.id`, assumes "principal" and "collaborator" are
 *      interchangeable, and stamps the collaborator value into the
 *      field. Recorded as the leading capture-error pattern on prod
 *      (e.g. `wanted_by_principal_id must be a principal id…`).
 *
 * Same treatment for the singular `*_principal_id` and the plural
 * `*_principal_ids[]` fields. Values that already start with
 * `principal_` pass through unchanged.
 */
async function reconcilePrincipalFields(
  // biome-ignore lint/suspicious/noExplicitAny: draft is parameterized at the entry callsite
  draft: any,
  docoId: string,
  me: MeLike,
  singularFields: readonly string[],
  listFields: readonly string[] = [],
): Promise<void> {
  if (!me.id) return;
  const mePrincipalPromise = resolvePrincipalIdForCollaborator(docoId, me.id);

  for (const field of singularFields) {
    const v = draft[field];
    if (v === undefined || v === null || v === "") {
      const mePid = await mePrincipalPromise;
      if (mePid) draft[field] = mePid;
    } else if (typeof v === "string" && v.startsWith("collaborator_")) {
      const pid = await resolvePrincipalIdForCollaborator(docoId, v);
      if (pid) draft[field] = pid;
    }
  }

  for (const field of listFields) {
    const v = draft[field];
    if (!Array.isArray(v)) continue;
    for (let i = 0; i < v.length; i++) {
      const id = v[i];
      if (typeof id === "string" && id.startsWith("collaborator_")) {
        const pid = await resolvePrincipalIdForCollaborator(docoId, id);
        if (pid) v[i] = pid;
      }
    }
  }
}

async function fillEvalAuthorFromAuth(draft: EvalDraft, me: MeLike, docoId: string): Promise<void> {
  if (!me.id || draft.authored_by_principal_id) return;
  const authorPrincipalId = await resolvePrincipalIdForCollaborator(docoId, me.id);
  if (authorPrincipalId) {
    draft.authored_by_principal_id = authorPrincipalId;
    return;
  }
  draft.created_by_collaborator_id = me.id;
}

interface RegistryEntry {
  // biome-ignore lint/suspicious/noExplicitAny: registry erases the per-entity Draft type
  build: () => ReturnType<typeof makeCaptureRoute<any>>;
  /** Singular entity_type used by the storage layer (e.g. "intent"). */
  entityType: string;
}

function entry<TDraft>(
  type: string,
  entityType: string,
  captureFn: Parameters<typeof makeCaptureRoute<TDraft>>[0]["captureFn"],
  fillFromAuth?: (draft: TDraft, me: MeLike, docoId: string) => Promise<void> | void,
): RegistryEntry {
  return {
    entityType,
    build: () =>
      makeCaptureRoute<TDraft>({
        type,
        captureFn,
        ...(fillFromAuth ? { fillFromAuth } : {}),
      }),
  };
}

// Neurons only — policies use /<handle>/api/policies.json so they
// stay separate from domain captures.
//
// fillFromAuth helpers resolve the collaborator → principal NEURON
// before stamping defaults. Without this resolution, the capture
// validator (which checks for `principal_*` ids) rejects every
// auto-filled write with "must be a principal id, not a
// collaborator id".
const CAPTURE_REGISTRY: Record<string, RegistryEntry> = {
  decisions: entry<DecisionDraft>("decisions", "decision", captureDecision, (draft, me, docoId) =>
    reconcilePrincipalFields(draft, docoId, me, [
      "decided_by_principal_id",
      "created_by_principal_id",
    ]),
  ),
  intents: entry<IntentDraft>("intents", "intent", captureIntent, (draft, me, docoId) =>
    reconcilePrincipalFields(
      draft,
      docoId,
      me,
      ["wanted_by_principal_id"],
      ["actors_principal_ids", "stakeholders_principal_ids"],
    ),
  ),
  ideas: entry<IdeaDraft>("ideas", "idea", captureIdea, (draft, me, docoId) =>
    reconcilePrincipalFields(draft, docoId, me, ["created_by_principal_id"]),
  ),
  actions: entry<ActionDraft>("actions", "action", captureAction, (draft, me, docoId) =>
    reconcilePrincipalFields(
      draft,
      docoId,
      me,
      ["actor_principal_id", "created_by_principal_id"],
      ["actors_principal_ids"],
    ),
  ),
  references: entry<ReferenceDraft>(
    "references",
    "reference",
    captureReference,
    (draft, me, docoId) => reconcilePrincipalFields(draft, docoId, me, ["created_by_principal_id"]),
  ),
  rules: entry<RuleDraft>("rules", "rule", captureRule, (draft, me, docoId) =>
    reconcilePrincipalFields(draft, docoId, me, [
      "authored_by_principal_id",
      "created_by_principal_id",
    ]),
  ),
  logs: entry<LogDraft>("logs", "log", captureLog, (draft, me, docoId) =>
    reconcilePrincipalFields(draft, docoId, me, ["actor_principal_id", "created_by_principal_id"]),
  ),
  evals: entry<EvalDraft>("evals", "eval", captureEval, fillEvalAuthorFromAuth),
  states: entry<StateDraft>("states", "state", captureState, (draft, me, docoId) =>
    reconcilePrincipalFields(draft, docoId, me, ["created_by_principal_id"]),
  ),
};

function notFound(type: string | undefined): Response {
  if (type === "guidance_policies" || type === "neuron_authoring_policies") {
    return Response.json(
      {
        error: `${type} are policies, not neurons. Use /api/policies.json instead (GET to list, POST with "policy_kind" to capture). See /api/policies.txt for the body shape.`,
      },
      { status: 404 },
    );
  }
  return Response.json({ error: `Unknown entity type "${type ?? ""}".` }, { status: 404 });
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams & { type: string };
}) {
  const cfg = CAPTURE_REGISTRY[params.type];
  if (!cfg) return notFound(params.type);
  const { meta } = await loadDocoRouteForRead(request, params);
  const rows = await listEntitiesByDoco(cfg.entityType, meta.docoId);
  return Response.json({
    ok: true,
    type: params.type,
    doco_id: meta.docoId,
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      summary: r.summary ?? null,
      lifecycle: r.lifecycle ?? null,
      created_at: r.created_at ?? null,
      created_by: r.created_by ?? null,
      updated_at: r.updated_at ?? null,
      updated_by: r.updated_by ?? null,
      data: r.data,
      body_md: r.body_md ?? null,
    })),
  });
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams & { type: string };
}) {
  const cfg = CAPTURE_REGISTRY[params.type];
  if (!cfg) return notFound(params.type);
  return cfg.build().action({ request, params });
}
