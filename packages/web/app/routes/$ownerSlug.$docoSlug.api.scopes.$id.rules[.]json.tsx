// POST /<owner>/<doco>/api/scopes/<scope_id>/rules.json
//
// Prose-driven rule authoring (decision_01KRPET95G2QNTPCR0YWAKSCH5).
//
// The agent / CLI / external caller posts `{prose}` — plain English
// describing one or more rules. The server runs the same classifier
// the web UI uses (classifyRuleProse → OpenAI), splits multi-rule prose
// into atomic rows, picks the most-fitting deterministic predicate when
// one fits, otherwise falls back to {kind: "probabilistic", spec}. The
// classifier ALWAYS throws LlmUnavailableError when OpenAI can't be
// reached — no silent fallback to probabilistic. Per user choice
// recorded in the Decision, failure rejects the operation so the
// OPENAI_API_KEY dependency is loud.
//
// Unlike the web flow there is NO preview step — APIs and CLIs are
// non-interactive; commit-immediately.

import { parse as parseYaml } from "yaml";
import type { EntityId } from "@doco/shared";
import { withClient } from "@doco/db";
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin } from "~/lib/doco-access.server";
import { renderOperationLines } from "~/lib/capture.server";
import {
  classifyRuleProse,
  LlmUnavailableError,
  type ClassifiedRule,
} from "~/lib/llm.server";
import { reindex, updateScopeInDoco } from "~/lib/redeem.server";
import { listScopeDetails, readDocoMetadata } from "~/lib/scope-helpers.server";

interface RuleProseBody {
  prose?: string;
}

export function loader() {
  return Response.json(
    {
      error:
        "Use POST with `{prose: string}` to add rules. See /<owner>/<doco>/api/scopes.txt for the spec.",
    },
    { status: 405 },
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string; id: string };
}) {
  const { ownerSlug, docoSlug, id } = params;
  await loadDocoForAdmin(request, ownerSlug, docoSlug);
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
    return Response.json(
      { error: "Content-Type must be application/json." },
      { status: 400 },
    );
  }
  let body: RuleProseBody;
  try {
    body = (await request.json()) as RuleProseBody;
  } catch (e) {
    return Response.json(
      { error: `Invalid JSON body: ${(e as Error).message}` },
      { status: 400 },
    );
  }
  const prose = (body.prose ?? "").trim();
  if (!prose) {
    return Response.json(
      { error: "`prose` is required — describe the rule in your own words." },
      { status: 400 },
    );
  }

  const scopeRaw = await readScopeFromDb(meta.docoId, id);
  if (!scopeRaw) {
    return Response.json({ error: `Scope not found: ${id}` }, { status: 404 });
  }
  const scopeName = String(scopeRaw.name ?? id);
  const scopeIcon = typeof scopeRaw.icon === "string" ? scopeRaw.icon : undefined;

  const allScopeDetails = await listScopeDetails(dir);
  const availableScopes = allScopeDetails.map((s) => ({ id: s.id, name: s.name }));

  const t0 = Date.now();
  let classified: ClassifiedRule[];
  try {
    classified = await classifyRuleProse({
      prose,
      scopeName,
      availableScopes,
    });
  } catch (e) {
    if (e instanceof LlmUnavailableError) {
      return Response.json(
        {
          error: `Classifier unavailable — ${e.message} The host must reach OpenAI to author rules from prose.`,
        },
        { status: 503 },
      );
    }
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  // Persist: existing rules + new classified rules. The original prose
  // slice lives on each deterministic rule's `reason` so the rule list
  // shows the human-authored intent next to the predicate shorthand.
  const existing: unknown[] = Array.isArray(scopeRaw.rules) ? (scopeRaw.rules as unknown[]) : [];
  const newRules = classified.map((c) => {
    const base = { ...c.rule } as Record<string, unknown>;
    if (
      c.rule.kind !== "probabilistic" &&
      (typeof base.reason !== "string" || base.reason.trim() === "") &&
      c.text.trim()
    ) {
      base.reason = c.text.trim();
    }
    return base;
  });
  const next = [...existing, ...newRules];
  await updateScopeInDoco({
    docoDir: dir,
    scopeId: id as EntityId<"scope">,
    rules: next,
  });
  await reindex(dir);

  const duration_ms = Date.now() - t0;
  const ops = classified.map((c) => ({
    kind: "added" as const,
    summary: `Rule (${c.rule.kind}): ${c.text}`,
  }));
  const footer_lines = renderOperationLines({
    ownerSlug,
    docoSlug,
    nodeType: "scope",
    id,
    summary: `${classified.length} rule${classified.length === 1 ? "" : "s"} added to scope ${scopeName}`,
    docoHost: new URL(request.url).origin,
    ops,
    scopes: scopeIcon ? [{ name: scopeName, icon: scopeIcon }] : [{ name: scopeName }],
    duration_ms,
  });

  return Response.json(
    {
      added: classified,
      total: next.length,
      footer_lines,
    },
    { status: 201 },
  );
}

async function readScopeFromDb(
  docoId: string,
  scopeId: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await withClient(async (c) => {
      const r = await c.query<{ raw_yaml: string }>(
        `SELECT raw_yaml FROM scopes WHERE id = $1 AND doco_id = $2 LIMIT 1`,
        [scopeId, docoId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return parseYaml(row.raw_yaml) as Record<string, unknown>;
    });
  } catch {
    return null;
  }
}
