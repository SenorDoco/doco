// Factories for the per-type capture (POST) and update (PATCH/POST) routes.
// Collapses ~13 near-identical handler files into one parameter set per route.
// Scope capture stays in its own file because its template-vs-custom branching
// + required `watched` flag don't fit the simple shape.

import { getEntity } from "@doco/db";
import { parse as parseYaml } from "yaml";
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, loadDocoForRead } from "~/lib/doco-access.server";
import { withIdempotency } from "~/lib/idempotency.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import {
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
  ownerSlug: string;
  docoSlug: string;
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
      await loadDocoForRead(request, params.ownerSlug, params.docoSlug);
      return Response.json(
        { error: `Use POST to capture. See /<owner>/<doco>/api/${cfg.type}.txt for the spec.` },
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
      const { ownerSlug, docoSlug } = params;
      const { me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
      const dir = docoPath(ownerSlug, docoSlug);
      const meta = await readDocoMetadata(dir);
      if (!meta) {
        return Response.json(
          { error: `Doco "${ownerSlug}/${docoSlug}" not found.` },
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
    // GET /<owner>/<doco>/api/<plural>/<id>.json — read the entity body.
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
      const { ownerSlug, docoSlug, id } = params;
      const ctx = await loadDocoForRead(request, ownerSlug, docoSlug);
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
      const { ownerSlug, docoSlug, id } = params;
      const { me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
      const dir = docoPath(ownerSlug, docoSlug);
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
