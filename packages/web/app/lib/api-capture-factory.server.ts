// Factories for the per-type capture (POST) and update (PATCH/POST) routes.
// Collapses ~13 near-identical handler files into one parameter set per route.

import { entityAsOf, getEntity, getVersions, verifyHistory, withClient } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { parse as parseYaml } from "yaml";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import { authoringContextForRequest } from "~/lib/authoring-source.server";
import {
  type AuthoringWriteContext,
  type CaptureError,
  type CaptureResult,
  type EntityPatch,
  type NodeTypeName,
  updateEntity,
} from "~/lib/capture.server";
import {
  type DocoRouteParams,
  loadDocoRouteForRead,
  requireDocoTypeWriteForRequest,
} from "~/lib/doco-access.server";
import { unsupportedNodeJsonEdgeKeyError } from "~/lib/graph-authoring-contract.server";
import { withIdempotency } from "~/lib/idempotency.server";
import { NODE_TYPE_META } from "~/lib/node-types";
import { recordCaptureTiming, withCaptureTelemetry } from "~/lib/telemetry.server";

interface MeLike {
  id: string | null;
  username: string;
}

// The type-named prose field each captureX function calls `.trim()` on.
// Used by the factory to reject non-string values with a 400 instead of
// letting `.trim()` throw a 500 deep in the capture function. Derived from
// the shared per-type registry (`NODE_TYPE_META`).
const PROSE_FIELD: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NODE_TYPE_META).map(([type, meta]) => [type, meta.proseField]),
);

type RouteParams = DocoRouteParams;

interface IdRouteParams extends RouteParams {
  id: string;
}

type CaptureFn<TDraft> = (
  docoDir: string,
  docoId: string,
  ownerSlug: string,
  docoSlug: string,
  draft: TDraft,
  docoHost?: string,
  authoring?: AuthoringWriteContext,
) => Promise<CaptureResult | CaptureError>;

export interface CaptureRouteConfig<TDraft> {
  /** Plural url segment (e.g. "intents", "decisions", "references"). */
  type: string;
  /** Singular entity type (e.g. "intent", "reference"); used for relation-owner checks. */
  entityType: string;
  /** Backing capture function from capture.server.ts. */
  captureFn: CaptureFn<TDraft>;
  /**
   * Optional: fill any domain Principal defaults on the draft from the
   * authenticated user. Creator provenance is stamped centrally
   * from the same authenticated user before this hook runs.
   */
  fillFromAuth?: (draft: TDraft, me: MeLike, docoId: string) => Promise<void> | void;
}

export function makeCaptureRoute<TDraft>(cfg: CaptureRouteConfig<TDraft>) {
  return {
    async loader({
      request,
      params,
    }: {
      request: Request;
      params: RouteParams;
    }) {
      await loadDocoRouteForRead(request, params);
      return Response.json(
        { error: `Use POST to capture. See /<doco-handle>/api/${cfg.type}.txt for the spec.` },
        { status: 405 },
      );
    },

    async action({
      request,
      params,
    }: {
      request: Request;
      params: RouteParams;
    }) {
      // Captures are writes, but write is now granted per type
      // (decision_per_type_write_grants), so the route gate only requires
      // read; the per-type write gate below is the real check. A token
      // scoped to a Doco for write-on-some-types is role-reader at the
      // Doco level, so a blanket "writer" route gate would wrongly reject
      // it before the per-type check ran.
      const { dir, docoSlug, me, meta, ownerSlug } = await loadDocoRouteForRead(
        request,
        params,
        "reader",
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

      return withIdempotency(
        request,
        `POST /api/${cfg.type}`,
        me?.id ?? null,
        bodyText,
        async () => {
          let draft: TDraft;
          try {
            draft = JSON.parse(bodyText) as TDraft;
          } catch (e) {
            return Response.json(
              { error: `Invalid JSON body: ${(e as Error).message}` },
              { status: 400 },
            );
          }

          const nodeJsonEdgeKeyError = unsupportedNodeJsonEdgeKeyError(
            cfg.entityType,
            draft as Record<string, unknown>,
          );
          if (nodeJsonEdgeKeyError) {
            return Response.json({ error: nodeJsonEdgeKeyError }, { status: 400 });
          }

          // Reject non-string prose fields up front: the captureX functions
          // call `.trim()` on the type-named prose field (intent/decision/…),
          // which throws TypeError → 500 when a client sends an object or
          // array. A typed boundary check turns that into a clean 400.
          const proseField = PROSE_FIELD[cfg.entityType];
          if (proseField) {
            const v = (draft as Record<string, unknown>)[proseField];
            if (v !== undefined && typeof v !== "string") {
              return Response.json({ error: `'${proseField}' must be a string.` }, { status: 400 });
            }
          }

          // Per-type write enforcement (decision_per_type_write_grants):
          // the principal must hold write access on THIS node type
          // (owner writes everything; a writer's grant must cover the
          // type via the wildcard or by name), AND — for bearer auth —
          // the token's per-type scope-down must allow it too.
          const denied = await requireDocoTypeWriteForRequest(
            request,
            { ownerId: meta.ownerId, docoId: meta.docoId },
            me.id,
            cfg.entityType,
            "write",
          );
          if (denied) return denied;

          stampAuthenticatedCreator(draft as object, me.id);
          if (me && cfg.fillFromAuth) {
            await cfg.fillFromAuth(draft, { id: me.id, username: me.username }, meta.docoId);
          }
          const docoHost = new URL(request.url).origin;
          const authoring = await authoringContextForRequest(request);
          const start = performance.now();
          const { result, bag } = await withCaptureTelemetry(() =>
            cfg.captureFn(dir, meta.docoId, ownerSlug, docoSlug, draft, docoHost, authoring),
          );
          const totalMs = Math.round(performance.now() - start);
          const isError = "error" in result;
          const status = isError ? 400 : 201;
          waitUntil(
            recordCaptureTiming({
              doco_id: meta.docoId,
              entity_type: cfg.type,
              http_method: "POST",
              principal_id: me?.id ?? null,
              total_ms: totalMs,
              bag,
              status_code: status,
              user_agent: request.headers.get("user-agent"),
              error: isError ? String((result as CaptureError).error) : null,
            }),
          );
          return Response.json(result, { status });
        },
      );
    },
  };
}

export interface UpdateRouteConfig {
  /** Plural url segment (e.g. "intents"). */
  type: string;
  /** Singular entity_type stored on the YAML (e.g. "intent"). */
  entityType: NodeTypeName;
  /** Plural directory name under docoDir (usually matches `type`). */
  pluralDir: string;
}

export function makeUpdateRoute(cfg: UpdateRouteConfig) {
  return {
    // GET /<doco-handle>/api/<plural>/<id>.json — read the entity body.
    // Reachable from the agent-facing short form `/by-id/<doco_id>/<typed_ulid>.json`
    // via the catchall redirect. Read access (not admin) — anyone who can
    // see the Doco can read entity bodies.
    async loader({
      request,
      params,
    }: {
      request: Request;
      params: IdRouteParams;
    }) {
      const { id } = params;
      const ctx = await loadDocoRouteForRead(request, params);
      const rec = await getEntity(cfg.entityType, id);
      // Cross-doco probe by ULID is effectively unguessable (128 bits), but
      // we still gate on the doco the caller actually has read access to —
      // returning 404 for "wrong doco" matches the agent-facing contract.
      if (!rec || rec.doco_id !== ctx.meta.docoId) {
        return Response.json({ error: `${cfg.entityType} not found: ${id}` }, { status: 404 });
      }
      // Time-travel reads: ?history=1 returns the full append-only
      // version timeline; ?as_of=<tx_id> reconstructs the snapshot at/​before
      // that commit. O(1) snapshot reads — never a replay.
      const tt = new URL(request.url).searchParams;
      if (tt.get("history")) {
        const versions = await withClient((c) => getVersions(c, "node", id));
        return Response.json({ id, entity_type: cfg.entityType, versions });
      }
      if (tt.get("verify")) {
        const result = await withClient((c) => verifyHistory(c, "node", id));
        return Response.json({ id, entity_type: cfg.entityType, ...result });
      }
      const asOf = tt.get("as_of");
      if (asOf) {
        const txId = Number(asOf);
        if (!Number.isFinite(txId)) {
          return Response.json({ error: "as_of must be a numeric tx_id." }, { status: 400 });
        }
        const snapshot = await withClient((c) => entityAsOf(c, "node", id, txId));
        return Response.json({ id, as_of: txId, snapshot });
      }
      // Post-rename: the 9 migrated nodes expose their prose under
      // a single key matching the entity type (intent/decision/rule/...).
      // Policies surface their one-line rule as `policy` (renamed from
      // `summary` in 038) plus optional `body_md`. Principals don't
      // route through this factory.
      const response: Record<string, unknown> = {
        id: rec.id,
        entity_type: rec.entity_type,
        doco_id: rec.doco_id,
        lifecycle: rec.lifecycle ?? null,
        created_at: rec.created_at ?? null,
        updated_at: rec.updated_at ?? null,
        data: rec.data,
      };
      if (rec.type_named_value !== undefined && rec.type_named_value !== null) {
        response[cfg.entityType] = rec.type_named_value;
      } else if (typeof rec.data.policy === "string") {
        response.policy = rec.data.policy;
        response.body_md = rec.body_md ?? null;
      } else {
        response[cfg.entityType] = "";
      }
      return Response.json(response);
    },

    async action({
      request,
      params,
    }: {
      request: Request;
      params: IdRouteParams;
    }) {
      const { id } = params;
      // Patches are writes, gated per type below (see POST note); the
      // route gate only requires read.
      const { dir, docoSlug, me, meta, ownerSlug } = await loadDocoRouteForRead(
        request,
        params,
        "reader",
      );
      if (!me) {
        return Response.json({ error: "Authentication required to edit." }, { status: 401 });
      }
      if (request.method !== "PATCH" && request.method !== "POST") {
        return Response.json({ error: "Use PATCH or POST." }, { status: 405 });
      }
      const ct = (request.headers.get("content-type") ?? "").toLowerCase();
      if (!ct.includes("application/json")) {
        return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
      }
      let patch: EntityPatch;
      try {
        patch = (await request.json()) as EntityPatch;
      } catch (e) {
        return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
      }

      // Per-type write enforcement: editing a node (including lifecycle
      // moves drafting → asserted → retired) requires write access on
      // THIS node type. What a writer may do beyond that is governed by
      // the Doco's own policies, not a built-in role ladder.
      const existing = await getEntity(cfg.entityType, id);
      if (!existing || existing.doco_id !== meta.docoId) {
        return Response.json({ error: `${cfg.entityType} not found: ${id}` }, { status: 404 });
      }
      const denied = await requireDocoTypeWriteForRequest(
        request,
        { ownerId: meta.ownerId, docoId: meta.docoId },
        me.id,
        cfg.entityType,
        "edit",
      );
      if (denied) return denied;

      const authoring = await authoringContextForRequest(request);
      const start = performance.now();
      const { result, bag } = await withCaptureTelemetry(() =>
        updateEntity({
          docoDir: dir,
          docoId: meta.docoId,
          ownerSlug,
          docoSlug,
          entityType: cfg.entityType,
          pluralDir: cfg.pluralDir,
          id,
          patch,
          allowedFields: undefined,
          docoHost: new URL(request.url).origin,
          actorId: me?.id ?? null,
          authoring,
        }),
      );
      const totalMs = Math.round(performance.now() - start);
      const isError = "error" in result;
      const status = isError ? ((result as { status?: number }).status ?? 400) : 200;
      waitUntil(
        recordCaptureTiming({
          doco_id: meta.docoId,
          entity_type: cfg.entityType,
          http_method: "PATCH",
          principal_id: me?.id ?? null,
          total_ms: totalMs,
          bag,
          status_code: status,
          user_agent: request.headers.get("user-agent"),
          error: isError ? String((result as { error?: unknown }).error ?? "error") : null,
        }),
      );
      return Response.json(result, { status });
    },
  };
}
