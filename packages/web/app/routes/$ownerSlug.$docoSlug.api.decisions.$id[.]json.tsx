import { getEntity } from "@doco/db";
import { parse as parseYaml } from "yaml";
import {
  enforceScopeRoleGate,
  loadScopeNamesByIds,
  makeUpdateRoute,
} from "~/lib/api-capture-factory.server";
import { docoPath } from "~/lib/db.server";
import { loadDocoForRead, normalizeDocoParams } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { updateDecision, type DecisionPatch } from "~/lib/capture.server";

/**
 * GET /<doco-handle>/api/decisions/<id>.json — read the Decision body.
 * Reachable from `/by-id/<doco_id>/decision_<ulid>.json` via the catchall
 * redirect. Shares the factory's generic entity-read loader.
 *
 * PATCH /<doco-handle>/api/decisions/<id>.json — update an existing
 * Decision in place. Custom action (not the factory's `updateEntity`)
 * because decisions carry ADR-specific logic: setting `is_adr: false`
 * demotes (clears scope_adr + number); `is_adr: true` promotes (adds
 * scope_adr + assigns next number).
 *
 * Auth shape mirrors the factory's PATCH route (rules, intents, actions,
 * …): token gates on `author` scope via `loadDocoForRead`; the scope-
 * role-gate enforces per-scope role + the `#global` constitution lock.
 * Previously this route used `loadDocoForAdmin`, which required the
 * OAuth token to be scoped to `owner` — that prevented an author-
 * scoped token from patching even a decision the principal owns at the
 * doco level. The factory's pattern is the right shape (per
 * decision_01KS0JBJ5X0AZ4XJJFKEWE1R62); decisions just couldn't use
 * the generic factory action because of the ADR promote/demote logic.
 *
 * Resource route — no default export.
 */
export const loader = makeUpdateRoute({
  type: "decisions",
  nodeType: "decision",
  pluralDir: "decisions",
  allowedFields: [],
}).loader;

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; id: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { id } = params;
  const { me } = await loadDocoForRead(request, handle, "author");
  if (!me) {
    return Response.json({ error: "Authentication required to edit." }, { status: 401 });
  }
  const dir = docoPath(handle);
  const meta = await readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ error: `Doco "${handle}" not found.` }, { status: 404 });
  }
  if (request.method !== "PATCH" && request.method !== "POST") {
    return Response.json({ error: "Use PATCH or POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  let patch: DecisionPatch;
  try {
    patch = (await request.json()) as DecisionPatch;
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }

  // Role gate — same shape as the factory PATCH path (rules, intents,
  // …). Reads the entity's current scope names, calls the shared gate.
  const existing = await getEntity("decision", id);
  if (!existing || existing.doco_id !== meta.docoId) {
    return Response.json({ error: `decision not found: ${id}` }, { status: 404 });
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
    // unparseable yaml — fall back to empty; the gate denies non-owner principals.
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
  }

  const docoHost = new URL(request.url).origin;
  const result = await updateDecision(dir, meta.docoId, ownerSlug, docoSlug, id, patch, docoHost, me?.id ?? null);
  if ("error" in result) {
    return Response.json(result, { status: result.status ?? 400 });
  }
  return Response.json(result, { status: 200 });
}
