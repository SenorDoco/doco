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
  type: string,
  entityType: string,
  captureFn: Parameters<typeof makeCaptureRoute<TDraft>>[0]["captureFn"],
  fillFromAuth?: (draft: TDraft, me: MeLike, docoId: string) => Promise<void> | void,
): RegistryEntry {
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
  decisions: entry<DecisionDraft>("decisions", "decision", captureDecision),
  intents: entry<IntentDraft>("intents", "intent", captureIntent),
  ideas: entry<IdeaDraft>("ideas", "idea", captureIdea),
  actions: entry<ActionDraft>("actions", "action", captureAction),
  references: entry<ReferenceDraft>("references", "reference", captureReference),
  rules: entry<RuleDraft>("rules", "rule", captureRule),
  logs: entry<LogDraft>("logs", "log", captureLog),
  evals: entry<EvalDraft>("evals", "eval", captureEval),
  states: entry<StateDraft>("states", "state", captureState),
};

export const CAPTURE_REGISTRY_BY_ENTITY_TYPE: Record<string, RegistryEntry> = Object.fromEntries(
  Object.values(CAPTURE_REGISTRY).map((entry) => [entry.entityType, entry]),
);
