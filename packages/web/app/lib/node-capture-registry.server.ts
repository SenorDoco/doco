import { GENERIC_CAPTURE_NODE_TYPES, NODE_CATALOG } from "@doco/shared";
import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import {
  type AuthoringWriteContext,
  type GenericNodeDraft,
  captureGenericNode,
} from "~/lib/capture.server";
import { type PrincipalDraft, capturePrincipal } from "~/lib/principal-capture.server";

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

/**
 * Generic node-capture entry: every generic node type routes through the
 * single `captureGenericNode` writer (node-shape slim-down), bound to its
 * entity_type. No per-type capture function — the API exposes the row
 * schema (`{prose, kind?, attributes}`) directly.
 */
function genericEntry(entityType: string): RegistryEntry {
  return entry<GenericNodeDraft>(
    entityType,
    (docoDir, docoId, ownerSlug, docoSlug, draft, docoHost, authoring) =>
      captureGenericNode(
        docoDir,
        docoId,
        ownerSlug,
        docoSlug,
        entityType,
        draft,
        docoHost,
        authoring,
      ),
  );
}

// Nodes only — policies use /<handle>/api/policies.json so they
// stay separate from domain captures. Every generic catalog node type is
// wired here automatically, so adding one to NODE_CATALOG (capture:
// "generic") lights up its capture route + changeset/contract coverage.
export const CAPTURE_REGISTRY: Record<string, RegistryEntry> = Object.fromEntries(
  GENERIC_CAPTURE_NODE_TYPES.map((entityType) => {
    const e = genericEntry(entityType);
    return [e.type, e];
  }),
);

// Bespoke captures: catalog node types (NODE_CATALOG[*].capture === "bespoke")
// whose body diverges from the shared `prose` column, so they carry their own
// captureFn instead of a generic one. Kept separate from CAPTURE_REGISTRY so the
// generic /<doco>/api/<type>.json route stays generic-only — these have their
// own bespoke route — while still being first-class everywhere that authors by
// entity_type (changeset, the authoring contract). Same CaptureFn contract, so
// nothing downstream special-cases them.
export const BESPOKE_CAPTURE_REGISTRY: Record<string, RegistryEntry> = {
  principals: entry<PrincipalDraft>("principal", capturePrincipal),
};

// All capture-able node types keyed by singular entity_type — generic AND
// bespoke. Changeset and any caller authoring by entity_type uses this, so a
// bespoke type can't silently fall out (guarded by node-type-capture-coverage).
export const CAPTURE_REGISTRY_BY_ENTITY_TYPE: Record<string, RegistryEntry> = Object.fromEntries(
  [...Object.values(CAPTURE_REGISTRY), ...Object.values(BESPOKE_CAPTURE_REGISTRY)].map((entry) => [
    entry.entityType,
    entry,
  ]),
);
