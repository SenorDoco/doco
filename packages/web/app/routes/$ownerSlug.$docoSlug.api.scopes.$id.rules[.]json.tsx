// POST /<doco-handle>/api/scopes/<scope_id>/rules.json
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

import { withClient } from "@doco/db";
import type { EntityId } from "@doco/shared";
import { parse as parseYaml } from "yaml";
import { renderOperationLines } from "~/lib/capture.server";
import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import {
  type ClassifiedRule,
  LlmUnavailableError,
  classifyRuleProse,
  formatRuleClassifierError,
  ruleClassifierErrorStatus,
} from "~/lib/llm.server";
import { createRuleInDoco, reindex } from "~/lib/redeem.server";
import { listScopeDetails, readDocoMetadata } from "~/lib/scope-helpers.server";

interface RuleProseBody {
  prose?: string;
}

export function loader() {
  return Response.json(
    {
      error:
        "Use POST with `{prose: string}` to add rules. See /<doco-handle>/api/scopes.txt for the spec.",
    },
    { status: 405 },
  );
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; id: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { id } = params;
  await loadDocoForAdmin(request, handle);
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
  let body: RuleProseBody;
  try {
    body = (await request.json()) as RuleProseBody;
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
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
          error: formatRuleClassifierError(e),
        },
        { status: ruleClassifierErrorStatus(e) },
      );
    }
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }

  // Per decision_01KRPRDR1AD7S1RP6E69BQDB2G each classified rule
  // becomes a first-class Rule entity (kind: authoring | guidance)
  // tagged with the scope via an `in_scope_of` edge.
  if (!meta?.docoId) {
    return Response.json({ error: "Doco metadata missing." }, { status: 500 });
  }
  const docoId = meta.docoId as EntityId<"doco">;
  let addedAuthoring = 0;
  let addedGuidance = 0;
  const addedRules: Array<ClassifiedRule & { id: EntityId<"rule">; summary: string }> = [];
  for (const c of classified) {
    if (c.bucket === "guidance") {
      if (c.text.trim()) {
        const summary = c.text.trim();
        const ruleId = await createRuleInDoco({
          docoId,
          kind: "guidance",
          summary,
          scopeId: id as EntityId<"scope">,
          createdBy: null,
        });
        addedRules.push({ ...c, id: ruleId, summary });
        addedGuidance++;
      }
      continue;
    }
    // v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): the predicate IS what
    // makes this rule authoring for the scope. `createRuleInDoco`
    // auto-wires the rule id into `Scope.gated_by`; the engine reads
    // the citation, not a flag on the rule.
    const summary = c.text.trim() || `Authoring rule (${c.rule.kind})`;
    const ruleId = await createRuleInDoco({
      docoId,
      summary,
      predicate: c.rule,
      scopeId: id as EntityId<"scope">,
      createdBy: null,
    });
    addedRules.push({ ...c, id: ruleId, summary });
    addedAuthoring++;
  }
  await reindex(dir);

  const duration_ms = Date.now() - t0;
  const docoHost = new URL(request.url).origin;
  const scopes = scopeIcon ? [{ name: scopeName, icon: scopeIcon }] : [{ name: scopeName }];
  const footer_lines = (
    await Promise.all(
      addedRules.map((rule, index) =>
        renderOperationLines({
          docoId,
          ownerSlug,
          docoSlug,
          nodeType: "rule",
          id: rule.id,
          summary: rule.summary,
          docoHost,
          ops: [{ kind: "added", summary: rule.summary }],
          scopes,
          duration_ms: index === addedRules.length - 1 ? duration_ms : undefined,
        }),
      ),
    )
  ).flat();

  return Response.json(
    {
      added: addedRules.map((rule) => ({
        ...rule,
        url: `${docoHost}/${handle}/rule/${rule.id}`,
      })),
      added_authoring: addedAuthoring,
      added_guidance: addedGuidance,
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
        "SELECT raw_yaml FROM scopes WHERE id = $1 AND doco_id = $2 LIMIT 1",
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
