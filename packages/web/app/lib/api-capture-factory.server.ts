// Factories for the per-type capture (POST) and update (PATCH/POST) routes.
// Collapses ~13 near-identical handler files into one parameter set per route.
// Scope capture stays in its own file because its template-vs-custom branching
// + required `watched` flag don't fit the simple shape.

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
      const meta = readDocoMetadata(dir);
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
    loader() {
      return Response.json({ error: "Use PATCH or POST with a JSON body." }, { status: 405 });
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
      const meta = readDocoMetadata(dir);
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
