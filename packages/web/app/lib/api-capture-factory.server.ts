// Factories for the per-type capture (POST) and update (PATCH/POST) routes.
// Collapses ~13 near-identical handler files into one parameter set per route.
// Scope capture stays in its own file because its template-vs-custom branching
// + required `watched` flag don't fit the simple shape.

import { type DocoRole, getEntity, ROLE_RANK, roleAtLeast, withClient } from "@doco/db";
import { parse as parseYaml } from "yaml";
import { docoPath } from "~/lib/db.server";
import {
  getDocoLevelRole,
  getEffectiveScopeRole,
  loadDocoForRead,
  normalizeDocoParams,
} from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";
import { readDocoMetadata, type DocoMetadata } from "~/lib/scope-helpers.server";
import {
  resolveScopeNames,
  updateEntity,
  type CaptureError,
  type CaptureResult,
  type EntityPatch,
  type NodeTypeName,
} from "~/lib/capture.server";

interface MeLike {
  id: string | null;
  username: string;
}

interface RouteParams {
  docoId: string;
}

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
) => Promise<CaptureResult | CaptureError>;

export interface CaptureRouteConfig<TDraft> {
  /** Plural url segment (e.g. "intents", "decisions", "references"). */
  type: string;
  /** Backing capture function from capture.server.ts. */
  captureFn: CaptureFn<TDraft>;
  /**
   * Optional: fill any default fields on the draft from the authenticated
   * principal. Called only when `me` is present and the draft doesn't
   * already carry the field. Guards the orphan-file bug (capture endpoints
   * used to write YAML missing the principal id when called by agents).
   */
  fillFromAuth?: (draft: TDraft, me: MeLike) => void;
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
      const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
      await loadDocoForRead(request, handle);
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
      const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
      const { me } = await loadDocoForRead(request, handle);
      if (!me) {
        return Response.json(
          { error: "Authentication required to write." },
          { status: 401 },
        );
      }
      const dir = docoPath(handle);
      const meta = await readDocoMetadata(dir);
      if (!meta) {
        return Response.json(
          { error: `Doco "${handle}" not found.` },
          { status: 404 },
        );
      }
      if (request.method !== "POST") {
        return Response.json({ error: "Use POST." }, { status: 405 });
      }
      const ct = (request.headers.get("content-type") ?? "").toLowerCase();
      if (!ct.includes("application/json")) {
        return Response.json(
          { error: "Content-Type must be application/json." },
          { status: 400 },
        );
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

          // Role gate (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62). Pulls the
          // target scope names off the draft, verifies the caller can write
          // each one (author+), forces lifecycle=`proposed` if the caller's
          // min role across targets is exactly author, and locks #global
          // to doco-level owners. Unknown scope names fall through so the
          // capture function returns its richer error.
          const draftLike = draft as unknown as { scope_names?: unknown; lifecycle?: string };
          const scopeNames = Array.isArray(draftLike.scope_names)
            ? draftLike.scope_names.filter((s): s is string => typeof s === "string")
            : [];
          if (scopeNames.length > 0) {
            const gate = await enforceScopeRoleGate({
              meta,
              docoDir: dir,
              scopeNames,
              principalId: me.id,
              mutatesLifecycle: false,
            });
            if (!gate.ok) {
              return Response.json({ error: gate.error }, { status: gate.status });
            }
            if (gate.shouldForceProposed) {
              draftLike.lifecycle = "proposed";
            }
          }

          if (me && cfg.fillFromAuth) {
            cfg.fillFromAuth(draft, { id: me.id, username: me.username });
          }
          const docoHost = new URL(request.url).origin;
          const result = await cfg.captureFn(
            dir,
            meta.docoId,
            ownerSlug,
            docoSlug,
            draft,
            docoHost,
          );
          if ("error" in result) {
            return Response.json(result, { status: 400 });
          }
          return Response.json(result, { status: 201 });
        },
      );
    },
  };
}

/**
 * Shared role gate for captures: resolves scope names, computes effective
 * scope-role for the principal on each, and returns the minimum role plus
 * any deny reason. Caller decides what to do with the result.
 */
async function enforceScopeRoleGate(args: {
  meta: DocoMetadata;
  docoDir: string;
  scopeNames: string[];
  principalId: string | null;
  /** True when the request changes a node's `lifecycle` (PATCH lifecycle).
   *  Requires approver+ on every covered scope when true. */
  mutatesLifecycle: boolean;
}): Promise<
  | { ok: true; minRole: DocoRole; shouldForceProposed: boolean }
  | { ok: false; status: number; error: string }
> {
  if (!args.principalId) {
    return { ok: false, status: 401, error: "Authentication required." };
  }
  const accessMeta = { ownerId: args.meta.ownerId, docoId: args.meta.docoId };
  const resolved = await resolveScopeNames(args.docoDir, args.scopeNames);
  // If the names don't resolve, hand control back to the caller — the
  // capture function will produce a clearer error.
  if (resolved.unknown.length > 0 || resolved.ids.length === 0) {
    return { ok: true, minRole: "owner", shouldForceProposed: false };
  }

  let minRole: DocoRole | null = null;
  for (const scopeId of resolved.ids) {
    const role = await getEffectiveScopeRole(accessMeta, scopeId, args.principalId);
    if (!role || !roleAtLeast(role, "author")) {
      return {
        ok: false,
        status: 403,
        error:
          "Forbidden: writing into one or more target scopes requires the 'author' role or higher.",
      };
    }
    if (args.mutatesLifecycle && !roleAtLeast(role, "approver")) {
      return {
        ok: false,
        status: 403,
        error:
          "Forbidden: changing a node's lifecycle requires the 'approver' role or higher on every scope the node belongs to.",
      };
    }
    if (!minRole || ROLE_RANK[role] < ROLE_RANK[minRole]) minRole = role;
  }

  // Constitution lock: any write touching #global requires doco-level owner.
  if (args.scopeNames.includes("#global")) {
    const docoRole = await getDocoLevelRole(accessMeta, args.principalId);
    if (docoRole !== "owner") {
      return {
        ok: false,
        status: 403,
        error:
          "Forbidden: only doco-level owners can write into #global (the constitution scope). Approver- or scope-level grants on #global do not permit constitution edits.",
      };
    }
  }

  const shouldForceProposed = minRole === "author";
  return { ok: true, minRole: minRole ?? "owner", shouldForceProposed };
}

/**
 * Resolve scope ids → scope names for the PATCH path's #global check.
 * We have the ids from the entity's raw_yaml; the gate needs to know
 * whether any of them is the constitution scope.
 */
async function loadScopeNamesByIds(scopeIds: string[]): Promise<string[]> {
  if (scopeIds.length === 0) return [];
  return withClient(async (c) => {
    const r = await c.query<{ name: string }>(
      `SELECT name FROM scopes WHERE id = ANY($1::text[])`,
      [scopeIds],
    );
    return r.rows.map((row) => String(row.name));
  });
}

export interface UpdateRouteConfig {
  /** Plural url segment (e.g. "intents"). */
  type: string;
  /** Singular node_type stored on the YAML (e.g. "intent"). */
  nodeType: NodeTypeName;
  /** Plural directory name under docoDir (usually matches `type`). */
  pluralDir: string;
  /** Fields the PATCH body is allowed to touch. */
  allowedFields: readonly string[];
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
      const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
      const ctx = await loadDocoForRead(request, handle);
      const rec = await getEntity(cfg.nodeType, id);
      // Cross-doco probe by ULID is effectively unguessable (128 bits), but
      // we still gate on the doco the caller actually has read access to —
      // returning 404 for "wrong doco" matches the agent-facing contract.
      if (!rec || rec.doco_id !== ctx.meta.docoId) {
        return Response.json(
          { error: `${cfg.nodeType} not found: ${id}` },
          { status: 404 },
        );
      }
      let parsed: unknown = null;
      try {
        parsed = parseYaml(rec.raw_yaml);
      } catch {
        // Malformed YAML on disk — return raw_yaml only and let the
        // caller cope. Don't 500 — the row exists.
      }
      return Response.json({
        id: rec.id,
        node_type: rec.node_type,
        doco_id: rec.doco_id,
        summary: rec.summary ?? null,
        lifecycle: rec.lifecycle ?? null,
        body_md: rec.body_md ?? null,
        created_at: rec.created_at ?? null,
        updated_at: rec.updated_at ?? null,
        raw_yaml: rec.raw_yaml,
        parsed,
      });
    },

    async action({
      request,
      params,
    }: {
      request: Request;
      params: IdRouteParams;
    }) {
      const { id } = params;
      const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
      const { me } = await loadDocoForRead(request, handle);
      if (!me) {
        return Response.json(
          { error: "Authentication required to edit." },
          { status: 401 },
        );
      }
      const dir = docoPath(handle);
      const meta = await readDocoMetadata(dir);
      if (!meta) return Response.json({ error: "Doco not found." }, { status: 404 });
      if (request.method !== "PATCH" && request.method !== "POST") {
        return Response.json({ error: "Use PATCH or POST." }, { status: 405 });
      }
      const ct = (request.headers.get("content-type") ?? "").toLowerCase();
      if (!ct.includes("application/json")) {
        return Response.json(
          { error: "Content-Type must be application/json." },
          { status: 400 },
        );
      }
      let patch: EntityPatch;
      try {
        patch = (await request.json()) as EntityPatch;
      } catch (e) {
        return Response.json({ error: `Invalid JSON: ${(e as Error).message}` }, { status: 400 });
      }

      // Role gate (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62). Reads the entity's
      // current scope ids, looks up their names, and checks the caller's
      // role on each. Lifecycle PATCH requires approver+; everything else
      // author+. #global membership locks to doco-level owner.
      const existing = await getEntity(cfg.nodeType, id);
      if (!existing || existing.doco_id !== meta.docoId) {
        return Response.json(
          { error: `${cfg.nodeType} not found: ${id}` },
          { status: 404 },
        );
      }
      let currentScopeIds: string[] = [];
      try {
        const fm = parseYaml(existing.raw_yaml) as { scopes?: unknown };
        if (Array.isArray(fm?.scopes)) {
          currentScopeIds = (fm.scopes as unknown[]).filter(
            (s): s is string => typeof s === "string",
          );
        }
      } catch {
        // unparseable yaml — fall back to no scopes; gate will deny if
        // the principal isn't doco-owner.
      }
      const currentScopeNames = await loadScopeNamesByIds(currentScopeIds);
      const lifecycleChange =
        patch.lifecycle !== undefined && patch.lifecycle !== existing.lifecycle;
      if (currentScopeNames.length > 0) {
        const gate = await enforceScopeRoleGate({
          meta,
          docoDir: dir,
          scopeNames: currentScopeNames,
          principalId: me.id,
          mutatesLifecycle: lifecycleChange,
        });
        if (!gate.ok) {
          return Response.json({ error: gate.error }, { status: gate.status });
        }
      } else {
        // Entity has no scopes — fall back to doco-level role check.
        const docoRole = await getDocoLevelRole(
          { ownerId: meta.ownerId, docoId: meta.docoId },
          me.id,
        );
        if (!docoRole || !roleAtLeast(docoRole, "author")) {
          return Response.json(
            { error: "Forbidden: author role required to edit." },
            { status: 403 },
          );
        }
        if (lifecycleChange && !roleAtLeast(docoRole, "approver")) {
          return Response.json(
            { error: "Forbidden: approver role required to change lifecycle." },
            { status: 403 },
          );
        }
      }

      const result = await updateEntity({
        docoDir: dir,
        docoId: meta.docoId,
        ownerSlug,
        docoSlug,
        nodeType: cfg.nodeType,
        pluralDir: cfg.pluralDir,
        id,
        patch,
        allowedFields: [...cfg.allowedFields],
        docoHost: new URL(request.url).origin,
        actorId: me?.id ?? null,
      });
      if ("error" in result) {
        const status = (result as { status?: number }).status ?? 400;
        return Response.json(result, { status });
      }
      return Response.json(result, { status: 200 });
    },
  };
}
