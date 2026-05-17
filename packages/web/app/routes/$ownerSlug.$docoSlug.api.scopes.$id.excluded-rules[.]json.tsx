// POST /<owner>/<doco>/api/scopes/<scope_id>/excluded-rules.json
//
// v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG). Append a Rule id to this
// scope's `excluded_rules` array — the per-scope opt-out for an
// inherited authoring rule. Idempotent; re-appending returns
// `{updated: false}`.

import { docoPath } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/scope-helpers.server";
import { reindex } from "~/lib/redeem.server";
import { appendExcludedRule } from "~/lib/scope-bulk.server";

interface Body {
  rule_id?: string;
}

export function loader() {
  return Response.json(
    { error: "Use POST with `{rule_id}` to exclude an inherited Rule from this scope." },
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
  const { ownerSlug, docoSlug } = await normalizeDocoParams(params);
  const { id } = params;
  if (request.method !== "POST") {
    return Response.json({ error: "POST required." }, { status: 405 });
  }
  await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const dir = docoPath(ownerSlug, docoSlug);
  const meta = await readDocoMetadata(dir);
  if (!meta?.docoId) {
    return Response.json({ error: "Doco metadata missing." }, { status: 500 });
  }
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Body must be JSON with `{rule_id}`." }, { status: 400 });
  }
  const ruleId = body.rule_id?.trim();
  if (!ruleId || !ruleId.startsWith("rule_")) {
    return Response.json(
      { error: "`rule_id` is required and must start with 'rule_'." },
      { status: 400 },
    );
  }
  let result: { updated: boolean };
  try {
    result = await appendExcludedRule({ scopeId: id, ruleId });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  if (result.updated) await reindex(dir, meta.docoId, [id]);
  return Response.json(
    {
      ok: true,
      scope_id: id,
      rule_id: ruleId,
      updated: result.updated,
    },
    { status: 200 },
  );
}
