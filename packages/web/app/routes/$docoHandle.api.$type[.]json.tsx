// Per-entity capture endpoint — single dispatcher for all `simple capture`
// entity types. Adding a new entity type means adding a row to
// CAPTURE_REGISTRY below; no new route file required.
//
// Special-cased routes that need custom logic (e.g. /api/decisions/<id>
// with ADR promotion, /api/principals with role-principal seeding,
// /api/invites, /api/settings, /api/audit) keep their dedicated route
// files and win the match by being more specific in routes.ts.

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
import type { DocoRouteParams } from "~/lib/doco-access.server";

interface MeLike {
  id: string | null;
  username: string;
}

interface RegistryEntry {
  // biome-ignore lint/suspicious/noExplicitAny: registry erases the per-entity Draft type
  build: () => ReturnType<typeof makeCaptureRoute<any>>;
}

function entry<TDraft>(
  type: string,
  captureFn: Parameters<typeof makeCaptureRoute<TDraft>>[0]["captureFn"],
  fillFromAuth?: (draft: TDraft, me: MeLike) => void,
): RegistryEntry {
  return {
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
const CAPTURE_REGISTRY: Record<string, RegistryEntry> = {
  decisions: entry<DecisionDraft>("decisions", captureDecision, (draft, me) => {
    if (!draft.decided_by_principal_id && me.id) draft.decided_by_principal_id = me.id;
    if (!draft.created_by_principal_id && me.id) draft.created_by_principal_id = me.id;
  }),
  intents: entry<IntentDraft>("intents", captureIntent, (draft, me) => {
    if (!draft.wanted_by_principal_id && me.id) draft.wanted_by_principal_id = me.id;
  }),
  ideas: entry<IdeaDraft>("ideas", captureIdea, (draft, me) => {
    if (!draft.created_by_principal_id && me.id) draft.created_by_principal_id = me.id;
  }),
  actions: entry<ActionDraft>("actions", captureAction, (draft, me) => {
    if (!draft.actor_principal_id && me.id) draft.actor_principal_id = me.id;
    if (!draft.created_by_principal_id && me.id) draft.created_by_principal_id = me.id;
  }),
  references: entry<ReferenceDraft>("references", captureReference, (draft, me) => {
    if (!draft.created_by_principal_id && me.id) draft.created_by_principal_id = me.id;
  }),
  rules: entry<RuleDraft>("rules", captureRule, (draft, me) => {
    if (!draft.authored_by_principal_id && me.id) draft.authored_by_principal_id = me.id;
    if (!draft.created_by_principal_id && me.id) draft.created_by_principal_id = me.id;
  }),
  logs: entry<LogDraft>("logs", captureLog, (draft, me) => {
    if (!draft.actor_principal_id && me.id) draft.actor_principal_id = me.id;
    if (!draft.created_by_principal_id && me.id) draft.created_by_principal_id = me.id;
  }),
  evals: entry<EvalDraft>("evals", captureEval, (draft, me) => {
    if (!draft.authored_by_principal_id && me.id) draft.authored_by_principal_id = me.id;
  }),
  states: entry<StateDraft>("states", captureState, (draft, me) => {
    if (!draft.created_by_principal_id && me.id) draft.created_by_principal_id = me.id;
  }),
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
  return cfg.build().loader({ request, params });
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
