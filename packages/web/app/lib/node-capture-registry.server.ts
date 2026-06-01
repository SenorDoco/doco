import { NODE_CATALOG } from "@doco/shared";
import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import {
  type ActionDraft,
  type AuthoringWriteContext,
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
  authoring?: AuthoringWriteContext,
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

function entry<TDraft>(
  entityType: string,
  captureFn: Parameters<typeof makeCaptureRoute<TDraft>>[0]["captureFn"],
  fillFromAuth?: (draft: TDraft, me: MeLike, docoId: string) => Promise<void> | void,
): RegistryEntry {
  const type = NODE_CATALOG[entityType as keyof typeof NODE_CATALOG]?.segment ?? `${entityType}s`;
  return {
    type,
    entityType,
    captureFn: (docoDir, docoId, ownerSlug, docoSlug, draft, docoHost, authoring) =>
      captureFn(docoDir, docoId, ownerSlug, docoSlug, draft as TDraft, docoHost, authoring),
    ...(fillFromAuth
      ? {
          fillFromAuth: (draft: unknown, me: MeLike, docoId: string) =>
            fillFromAuth(draft as TDraft, me, docoId),
        }
      : {}),
    build: () =>
      makeCaptureRoute<TDraft>({
        type,
        entityType,
        captureFn,
        ...(fillFromAuth ? { fillFromAuth } : {}),
      }) as unknown as ReturnType<typeof makeCaptureRoute<unknown>>,
  };
}

// Nodes only — policies use /<handle>/api/policies.json so they
// stay separate from domain captures.
export const CAPTURE_REGISTRY: Record<string, RegistryEntry> = {
  decisions: entry<DecisionDraft>("decision", captureDecision),
  intents: entry<IntentDraft>("intent", captureIntent),
  ideas: entry<IdeaDraft>("idea", captureIdea),
  actions: entry<ActionDraft>("action", captureAction),
  references: entry<ReferenceDraft>("reference", captureReference),
  rules: entry<RuleDraft>("rule", captureRule),
  logs: entry<LogDraft>("log", captureLog),
  evals: entry<EvalDraft>("eval", captureEval),
  states: entry<StateDraft>("state", captureState),
};

export const CAPTURE_REGISTRY_BY_ENTITY_TYPE: Record<string, RegistryEntry> = Object.fromEntries(
  Object.values(CAPTURE_REGISTRY).map((entry) => [entry.entityType, entry]),
);
