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
  type GuidanceArticleDraft,
  type IntentDraft,
  type LogDraft,
  type NodeAuthoringArticleDraft,
  type ReferenceDraft,
  type RuleDraft,
  type StateDraft,
  captureAction,
  captureDecision,
  captureEval,
  captureGuidanceArticle,
  captureIntent,
  captureLog,
  captureNodeAuthoringArticle,
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

const CAPTURE_REGISTRY: Record<string, RegistryEntry> = {
  decisions: entry<DecisionDraft>("decisions", captureDecision, (draft, me) => {
    if (!draft.decided_by_username) draft.decided_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  }),
  intents: entry<IntentDraft>("intents", captureIntent, (draft, me) => {
    if (!draft.wanted_by_username) draft.wanted_by_username = me.username;
  }),
  actions: entry<ActionDraft>("actions", captureAction, (draft, me) => {
    if (!draft.performed_by_username) draft.performed_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  }),
  references: entry<ReferenceDraft>("references", captureReference, (draft, me) => {
    if (!draft.created_by_username) draft.created_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  }),
  rules: entry<RuleDraft>("rules", captureRule, (draft, me) => {
    if (!draft.authored_by_username) draft.authored_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  }),
  guidance_articles: entry<GuidanceArticleDraft>(
    "guidance_articles",
    captureGuidanceArticle,
    (draft, me) => {
      if (!draft.authored_by_username) draft.authored_by_username = me.username;
      if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
    },
  ),
  node_authoring_articles: entry<NodeAuthoringArticleDraft>(
    "node_authoring_articles",
    captureNodeAuthoringArticle,
    (draft, me) => {
      if (!draft.authored_by_username) draft.authored_by_username = me.username;
      if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
    },
  ),
  logs: entry<LogDraft>("logs", captureLog, (draft, me) => {
    if (!draft.performed_by_username) draft.performed_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  }),
  evals: entry<EvalDraft>("evals", captureEval, (draft, me) => {
    if (!draft.authored_by_username) draft.authored_by_username = me.username;
  }),
  states: entry<StateDraft>("states", captureState, (draft, me) => {
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
    if (!draft.created_by_username) draft.created_by_username = me.username;
  }),
};

function notFound(type: string | undefined): Response {
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
