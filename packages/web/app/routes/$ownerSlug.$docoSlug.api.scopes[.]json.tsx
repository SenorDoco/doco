import { findScopeTemplate } from "@doco/host";
import type { EntityId } from "@doco/shared";
import { renderOperationLines } from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, loadDocoForRead, normalizeDocoParams } from "~/lib/doco-access.server";
import {
  createIntentInDoco,
  createScopeInDoco,
  reindex,
  seedScopeFromTemplate,
  updateScopeInDoco,
} from "~/lib/redeem.server";
import { listScopeDetails, readDocoMetadata } from "~/lib/scope-helpers.server";

/**
 * POST /<doco-handle>/api/scopes.json — single-call Scope creation.
 *
 * Per ADR-137bis every scope-creation surface MUST require an explicit
 * `watched: boolean` answer — a soft attention signal for contributors,
 * stored on the scope's own YAML. Missing `watched` → 400. Same auth
 * model as the other capture endpoints. Returns `footer_lines` ready
 * to paste verbatim.
 *
 * Body shape:
 *   - `template_name`: string (optional) — install a default template
 *     by name ("global" or "user-flows"). Cannot be combined with the
 *     custom-create fields below. Seeds the template's Intent + Rules
 *     into the new scope.
 *   - `name`: string (required if `template_name` absent) — lowercase,
 *     starts with a letter, no slashes.
 *   - `intent_summary`: string (required if `template_name` absent) —
 *     the main Intent this scope serves.
 *   - `icon`: string (optional) — single emoji.
 *   - `parent_id`: string (optional) — id of an existing scope to nest
 *     this one under.
 *   - `watched`: boolean (REQUIRED) — soft attention signal. NOT hard
 *     enforcement (use a `mandatory_scope` authoring rule on the Global
 *     scope for that). No default.
 *
 * Rule creation is deliberately separate from Scope creation. Add rules
 * after the scope exists with /api/scopes/<id>/rules.json.
 */

const SCOPE_NAME_RE = /^[a-z][a-z0-9_-]*$/;

interface ScopeCreateBody {
  template_name?: string;
  name?: string;
  intent_summary?: string;
  icon?: string;
  parent_id?: string;
  watched?: boolean;
}

const CREATE_TIME_RULE_FIELDS = ["authoring_rules", "guidance_rules", "rules"] as const;

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  await loadDocoForRead(request, handle);
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
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { me } = await loadDocoForAdmin(request, handle);
  const dir = docoPath(handle);
  const meta = await readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ error: `Doco "${handle}" not found.` }, { status: 404 });
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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "JSON body must be an object." }, { status: 400 });
  }
  const createTimeRuleField = CREATE_TIME_RULE_FIELDS.find((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (createTimeRuleField) {
    return Response.json(
      {
        error: `\`${createTimeRuleField}\` is no longer accepted during scope creation. Create the scope first, then POST rule prose to /${handle}/api/scopes/<scope_id>/rules.json.`,
      },
      { status: 400 },
    );
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
  // Framework-native behavior of the Global scope (the doco's
  // constitution, decision_01KRKS5H2A5QER84CJ8R4VD36Z): always watched.
  // Refuse watched=false on any path that would create a scope named
  // "global" — covers both template_name=global and the custom-name
  // path. (The existing 409 "already exists" check will also reject
  // duplicate creation, but this guard fires first and gives a clearer
  // error.)
  const resolvedName =
    body.template_name === "global" ? "global" : (body.name ?? "").trim().toLowerCase();
  if (resolvedName === "global" && body.watched === false) {
    return Response.json(
      {
        error:
          "The Global scope is always watched and cannot be unwatched (decision_01KRKS5H2A5QER84CJ8R4VD36Z).",
      },
      { status: 400 },
    );
  }
  const watched = body.watched;
  const createdBy = (me?.id ?? null) as EntityId<"principal"> | null;
  const docoId = meta.docoId as EntityId<"doco">;
  const t0 = Date.now();

  let createOpts: Parameters<typeof createScopeInDoco>[0];
  let customIntentSummary: string | null = null;
  let seedGuidanceText: string | null = null;
  let templateToSeed: NonNullable<ReturnType<typeof findScopeTemplate>> | null = null;

  if (body.template_name) {
    const tpl = findScopeTemplate(body.template_name);
    if (!tpl) {
      return Response.json({ error: `Unknown template: ${body.template_name}` }, { status: 400 });
    }
    const existing = await listScopeDetails(dir);
    if (existing.some((s) => s.name === tpl.name)) {
      return Response.json({ error: `Scope "${tpl.name}" already exists.` }, { status: 409 });
    }
    createOpts = {
      docoDir: dir,
      docoId,
      name: tpl.name,
      ...(tpl.icon ? { icon: tpl.icon } : {}),
      watched,
      createdBy,
    };
    templateToSeed = tpl;
    // Used by the footer summary fallback below — the seeded Intent
    // owns the prose, but the footer just needs a one-liner.
    seedGuidanceText = tpl.intentSummary;
  } else {
    const name = (body.name ?? "").trim().toLowerCase();
    customIntentSummary = (body.intent_summary ?? "").trim();
    if (!name) {
      return Response.json(
        { error: "Either `template_name` or `name` is required." },
        { status: 400 },
      );
    }
    if (!customIntentSummary) {
      return Response.json(
        { error: "`intent_summary` is required when creating a custom scope." },
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
      watched,
      createdBy,
    };
  }

  const newScopeId = await createScopeInDoco(createOpts);
  const changedEntityIds: string[] = [newScopeId];

  // Templates seed one Intent + one Rule per template rule. Custom
  // scopes only seed their main Intent; rules are added after creation.
  if (templateToSeed) {
    const seeded = await seedScopeFromTemplate({
      docoDir: dir,
      docoId,
      scopeId: newScopeId,
      template: templateToSeed,
      createdBy,
    });
    if (seeded.intentId) changedEntityIds.push(seeded.intentId);
    changedEntityIds.push(...seeded.ruleIds);
  } else if (customIntentSummary) {
    const intentId = await createIntentInDoco({
      docoId,
      summary: customIntentSummary,
      scopeId: newScopeId,
      createdBy,
    });
    await updateScopeInDoco({
      docoDir: dir,
      scopeId: newScopeId,
      intentIds: [intentId],
    });
    changedEntityIds.push(intentId);
  }

  await reindex(dir, docoId, changedEntityIds);
  const duration_ms = Date.now() - t0;

  const scopeName = createOpts.name;
  const scopeIcon = createOpts.icon;
  const summary =
    seedGuidanceText?.trim() ||
    customIntentSummary?.trim() ||
    `Scope: ${scopeName}${watched ? " (watched)" : ""}`;
  const footer_lines = await renderOperationLines({
    docoId,
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
