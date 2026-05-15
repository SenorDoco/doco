import type { EntityId } from "@doco/shared";
import { findScopeTemplate } from "@doco/host";
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, loadDocoForRead } from "~/lib/doco-access.server";
import { listScopeDetails, readDocoMetadata } from "~/lib/scope-helpers.server";
import { renderOperationLines } from "~/lib/capture.server";
import { createScopeInDoco, reindex } from "~/lib/redeem.server";

/**
 * POST /<owner>/<doco>/api/scopes.json — single-call Scope creation.
 *
 * Per ADR-137bis every scope-creation surface MUST require an explicit
 * `watched: boolean` answer — a soft attention signal for contributors,
 * stored on the scope's own YAML. Missing `watched` → 400. Same auth
 * model as the other capture endpoints. Returns `footer_lines` ready
 * to paste verbatim.
 *
 * Body shape:
 *   - `template_name`: string (optional) — install a default template
 *     by name (e.g. "user-flows", "bugs"). Cannot be combined with the
 *     custom-create fields below.
 *   - `name`: string (required if `template_name` absent) — lowercase,
 *     starts with a letter, no slashes.
 *   - `icon`: string (optional) — single emoji.
 *   - `purpose`: string (optional) — why this scope exists.
 *   - `guidelines`: string (optional) — markdown guidance for authors.
 *   - `parent_id`: string (optional) — id of an existing scope to nest
 *     this one under.
 *   - `rules`: unknown[] (optional) — pre-seeded checks (predicates the
 *     engine runs on every capture into this scope).
 *   - `watched`: boolean (REQUIRED) — soft attention signal. NOT hard
 *     enforcement (use a `mandatory_scope` check on the constitution
 *     scope for that).
 *     No default.
 */

const SCOPE_NAME_RE = /^[a-z][a-z0-9_-]*$/;

interface ScopeCreateBody {
  template_name?: string;
  name?: string;
  icon?: string;
  parent_id?: string;
  /**
   * Optional authoring rules — engine-readable predicates fired on
   * every capture into the scope. Use the prose endpoint
   * (/api/scopes/<id>/rules.json with `{prose}`) to author from plain
   * English; this typed field exists for callers that want to provide
   * the predicate shape directly.
   */
  authoring_rules?: unknown[];
  /** Optional guidance rules — prose for agents to read; no automated check. */
  guidance_rules?: string[];
  watched?: boolean;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  await loadDocoForRead(request, params.ownerSlug, params.docoSlug);
  return Response.json(
    {
      error:
        "Use POST to create a scope. Body must include `watched: boolean` (ADR-137bis) and either `template_name` or `name`.",
    },
    { status: 405 },
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = await readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ error: `Doco "${ownerSlug}/${docoSlug}" not found.` }, { status: 404 });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  let body: ScopeCreateBody;
  try {
    body = (await request.json()) as ScopeCreateBody;
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }

  if (typeof body.watched !== "boolean") {
    return Response.json(
      {
        error:
          "`watched` is required and must be a boolean — true (contributors should proactively look for opportunities to document into this scope) or false. No default per ADR-137bis.",
      },
      { status: 400 },
    );
  }
  // Fifth framework-native behavior of the Constitution scope
  // (decision_01KRKS5H2A5QER84CJ8R4VD36Z): always watched. Refuse
  // watched=false on any path that would create a scope named
  // "constitution" — covers both template_name=constitution and the
  // custom-name path. (The existing 409 "already exists" check will
  // also reject duplicate creation, but this guard fires first and
  // gives a clearer error.)
  const resolvedName =
    body.template_name === "constitution"
      ? "constitution"
      : (body.name ?? "").trim().toLowerCase();
  if (resolvedName === "constitution" && body.watched === false) {
    return Response.json(
      {
        error:
          "The Constitution scope is always watched and cannot be unwatched (decision_01KRKS5H2A5QER84CJ8R4VD36Z).",
      },
      { status: 400 },
    );
  }
  const watched = body.watched;
  const createdBy = (me?.id ?? null) as EntityId<"principal"> | null;
  const docoId = meta.docoId as EntityId<"doco">;
  const t0 = Date.now();

  let createOpts: Parameters<typeof createScopeInDoco>[0];

  if (body.template_name) {
    const tpl = findScopeTemplate(body.template_name);
    if (!tpl) {
      return Response.json({ error: `Unknown template: ${body.template_name}` }, { status: 400 });
    }
    const existing = await listScopeDetails(dir);
    if (existing.some((s) => s.name === tpl.name)) {
      return Response.json({ error: `Scope "${tpl.name}" already exists.` }, { status: 409 });
    }
    // Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA: template `purpose`
    // retired; `guidelines` text becomes the seed `guidance_rules[0]`.
    createOpts = {
      docoDir: dir,
      docoId,
      name: tpl.name,
      ...(tpl.icon ? { icon: tpl.icon } : {}),
      ...(tpl.guidelines ? { guidance_rules: [tpl.guidelines] } : {}),
      watched,
      createdBy,
    };
  } else {
    const name = (body.name ?? "").trim().toLowerCase();
    if (!name) {
      return Response.json(
        { error: "Either `template_name` or `name` is required." },
        { status: 400 },
      );
    }
    if (!SCOPE_NAME_RE.test(name)) {
      return Response.json(
        {
          error:
            "`name` must start with a letter and use only lowercase letters, digits, hyphens, underscores. No slashes (use `parent_id`).",
        },
        { status: 400 },
      );
    }
    const existing = await listScopeDetails(dir);
    if (existing.some((s) => s.name === name)) {
      return Response.json({ error: `Scope "${name}" already exists.` }, { status: 409 });
    }
    const parentScopes: EntityId<"scope">[] = [];
    if (body.parent_id) {
      const parent = existing.find((s) => s.id === body.parent_id);
      if (!parent) {
        return Response.json(
          { error: `Parent scope not found: ${body.parent_id}` },
          { status: 400 },
        );
      }
      parentScopes.push(parent.id as EntityId<"scope">);
    }
    createOpts = {
      docoDir: dir,
      docoId,
      name,
      ...(body.icon ? { icon: body.icon } : {}),
      parentScopes,
      ...(body.authoring_rules && body.authoring_rules.length > 0
        ? { authoring_rules: body.authoring_rules }
        : {}),
      ...(body.guidance_rules && body.guidance_rules.length > 0
        ? { guidance_rules: body.guidance_rules }
        : {}),
      watched,
      createdBy,
    };
  }

  const newScopeId = await createScopeInDoco(createOpts);
  await reindex(dir);
  const duration_ms = Date.now() - t0;

  const scopeName = createOpts.name;
  const scopeIcon = createOpts.icon;
  // Per decision_01KRPMC7CVDA9WZ5DKH81TVAAA there is no `purpose` field
  // any more. Use the first guidance rule as the summary if one exists,
  // otherwise fall back to a generic line.
  const firstGuidance = createOpts.guidance_rules?.[0]?.trim();
  const summary = firstGuidance || `Scope: ${scopeName}${watched ? " (watched)" : ""}`;
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "scope",
    id: newScopeId,
    summary,
    docoHost: new URL(request.url).origin,
    ops: [{ kind: "added", summary }],
    scopes: scopeIcon ? [{ name: scopeName, icon: scopeIcon }] : [{ name: scopeName }],
    duration_ms,
  });

  return Response.json(
    {
      id: newScopeId,
      name: scopeName,
      watched,
      footer_lines,
    },
    { status: 201 },
  );
}
