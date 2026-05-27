import { listPrincipals } from "@doco/db";
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

export interface MeLike {
  id: string | null;
  username: string;
}

type ErasedCaptureFn = (
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: unknown,
  docoHost?: string,
) => ReturnType<Parameters<typeof makeCaptureRoute<unknown>>[0]["captureFn"]>;

export interface RegistryEntry {
  build: () => ReturnType<typeof makeCaptureRoute<unknown>>;
  /** Plural url segment (e.g. "actions"). */
  type: string;
  /** Singular entity_type used by the storage layer (e.g. "action"). */
  entityType: string;
  captureFn: ErasedCaptureFn;
  fillFromAuth?: (draft: unknown, me: MeLike, docoId: string) => Promise<void> | void;
}

/**
 * Resolve the authenticated collaborator to a Principal NEURON id in
 * this doco. *_principal_id columns reference principals.id and
 * actively reject collaborator_* values, so we can't just stamp
 * `me.id` (which is a collaborator id) into them.
 */
const principalForCollaboratorCache = new Map<string, string>();
export async function resolvePrincipalIdForCollaborator(
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
 *   1. Field missing → fill with the calling user's resolved Principal.
 *   2. Field present but holds a `collaborator_*` id → resolve THAT
 *      collaborator to its Principal in this doco.
 */
export async function reconcilePrincipalFields<TDraft extends object>(
  draft: TDraft,
  docoId: string,
  me: MeLike,
  singularFields: readonly string[],
  listFields: readonly string[] = [],
): Promise<void> {
  if (!me.id) return;
  const mutable = draft as Record<string, unknown>;
  const mePrincipalPromise = resolvePrincipalIdForCollaborator(docoId, me.id);

  for (const field of singularFields) {
    const v = mutable[field];
    if (v === undefined || v === null || v === "") {
      const mePid = await mePrincipalPromise;
      if (mePid) mutable[field] = mePid;
    } else if (typeof v === "string" && v.startsWith("collaborator_")) {
      const pid = await resolvePrincipalIdForCollaborator(docoId, v);
      if (pid) mutable[field] = pid;
    }
  }

  for (const field of listFields) {
    const v = mutable[field];
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

function entry<TDraft>(
  type: string,
  entityType: string,
  captureFn: Parameters<typeof makeCaptureRoute<TDraft>>[0]["captureFn"],
  fillFromAuth?: (draft: TDraft, me: MeLike, docoId: string) => Promise<void> | void,
): RegistryEntry {
  return {
    type,
    entityType,
    captureFn: (docoDir, docoId, ownerSlug, docoSlug, draft, docoHost) =>
      captureFn(docoDir, docoId, ownerSlug, docoSlug, draft as TDraft, docoHost),
    ...(fillFromAuth
      ? {
          fillFromAuth: (draft: unknown, me: MeLike, docoId: string) =>
            fillFromAuth(draft as TDraft, me, docoId),
        }
      : {}),
    build: () =>
      makeCaptureRoute<TDraft>({
        type,
        captureFn,
        ...(fillFromAuth ? { fillFromAuth } : {}),
      }) as unknown as ReturnType<typeof makeCaptureRoute<unknown>>,
  };
}

// Neurons only — policies use /<handle>/api/policies.json so they
// stay separate from domain captures.
export const CAPTURE_REGISTRY: Record<string, RegistryEntry> = {
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

export const CAPTURE_REGISTRY_BY_ENTITY_TYPE: Record<string, RegistryEntry> = Object.fromEntries(
  Object.values(CAPTURE_REGISTRY).map((entry) => [entry.entityType, entry]),
);
