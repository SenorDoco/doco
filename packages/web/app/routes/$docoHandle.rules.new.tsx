import { withClient } from "@doco/db";
// /<doco-handle>/rules/new — minimal capture form for a domain Rule entity.
// Policy meta-rules live in guidance_policies and
// node_authoring_policies instead.
import { Form, redirect } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { stampAuthenticatedCreator } from "~/lib/authenticated-creator.server";
import { type RuleDraft, captureRule } from "~/lib/capture.server";
import { loadDocoRouteForAdmin } from "~/lib/doco-access.server";
import { captureEdge } from "~/lib/edge-capture.server";
import { loadHostConfig } from "~/lib/host.server";
import { resolvePrincipalIdForUser } from "~/lib/principal-user.server";

interface IntentOption {
  id: string;
  label: string;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { docoSlug, handle, me, meta, ownerSlug } = await loadDocoRouteForAdmin(request, params);
  const intents = await withClient(async (c) => {
    const rows = (
      await c.query<IntentOption>(
        `SELECT id, split_part(prose, E'\n', 1) AS label FROM nodes
          WHERE node_type = 'intent'
            AND doco_id = $1
            AND COALESCE(lifecycle, 'asserted') = 'asserted'
          ORDER BY created_at DESC`,
        [meta.docoId],
      )
    ).rows;
    return rows;
  });
  return {
    ownerSlug,
    docoSlug,
    handle,
    intents,
    host: await loadHostConfig(),
    me,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { dir, docoSlug, handle, me, meta, ownerSlug } = await loadDocoRouteForAdmin(
    request,
    params,
  );
  const form = await request.formData();
  const ruleText = String(form.get("rule") ?? form.get("summary") ?? "").trim();
  const predicate = String(form.get("predicate") ?? "").trim();
  const intentId = String(form.get("intent_id") ?? "").trim();
  const severityRaw = String(form.get("severity") ?? "hard");
  const enforcedByRaw = String(form.get("enforced_by") ?? "review");

  const severity = severityRaw === "soft" ? "soft" : "hard";
  const enforcedBy = (["runtime", "review", "manual"] as const).includes(
    enforcedByRaw as "runtime" | "review" | "manual",
  )
    ? (enforcedByRaw as "runtime" | "review" | "manual")
    : "review";
  const authorPrincipalId = me?.id ? await resolvePrincipalIdForUser(meta.docoId, me.id) : null;

  const draft: RuleDraft = stampAuthenticatedCreator(
    {
      rule: ruleText,
      predicate,
      severity,
      enforced_by: enforcedBy,
    } satisfies RuleDraft,
    me?.id,
  );

  const result = await captureRule(
    dir,
    meta.docoId,
    ownerSlug,
    docoSlug,
    draft,
    new URL(request.url).origin,
  );
  if ("error" in result) {
    return Response.json(result, { status: result.status ?? 400 });
  }
  if (authorPrincipalId) {
    const edge = await captureEdge({
      docoId: meta.docoId,
      actorId: me?.id ?? null,
      edgeType: "attributed_to",
      fromId: result.id,
      toId: authorPrincipalId,
      props: { role: "owned_by" },
      reason: `Rule ${result.id} authored by Principal ${authorPrincipalId}`,
      metadata: { route: "rules.new" },
    });
    if ("error" in edge) {
      return Response.json(edge, { status: edge.status });
    }
  }
  if (intentId) {
    const edge = await captureEdge({
      docoId: meta.docoId,
      actorId: me?.id ?? null,
      edgeType: "supports",
      fromId: result.id,
      toId: intentId,
      props: { role: "serves" },
      reason: `Rule ${result.id} serves Intent ${intentId}`,
      metadata: { route: "rules.new" },
    });
    if ("error" in edge) {
      return Response.json(edge, { status: edge.status });
    }
  }
  return redirect(`/${handle}/rule/${result.id}`);
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `New rule · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function NewRule({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, docoSlug, handle, intents, me } = loaderData;

  return (
    <div>
      <SiteHeader me={me} />
      <SingleColumnPageMain className="py-6 space-y-4">
        <Breadcrumb
          items={docoBreadcrumb({
            ownerSlug,
            handle,
            parent: { label: "Rules", to: `/${handle}/rule` },
            pageLabel: "New rule",
          })}
        />
        <Card>
          <CardHeader>
            <CardTitle>New rule</CardTitle>
            <CardDescription>
              Capture a load-bearing domain constraint for this project.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-4">
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Summary
                </span>
                <input
                  type="text"
                  name="summary"
                  required
                  maxLength={300}
                  placeholder="One-line statement of the rule."
                  className="mt-1 block w-full rounded-md px-3 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Predicate
                </span>
                <textarea
                  name="predicate"
                  required
                  rows={4}
                  placeholder="The machine-checkable or prose predicate the rule asserts."
                  className="mt-1 block w-full rounded-md px-3 py-2 text-sm font-mono"
                />
              </label>
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Intent served
                </span>
                <select
                  name="intent_id"
                  className="mt-1 block rounded-md px-3 py-2 text-sm"
                  defaultValue=""
                >
                  <option value="">(none)</option>
                  {intents.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.label.slice(0, 100)}
                      {i.label.length > 100 ? "…" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex gap-6">
                <fieldset>
                  <legend className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Severity
                  </legend>
                  <label className="mt-1 flex items-center gap-1 text-xs">
                    <input type="radio" name="severity" value="hard" defaultChecked />
                    hard (blocker)
                  </label>
                  <label className="mt-1 flex items-center gap-1 text-xs">
                    <input type="radio" name="severity" value="soft" />
                    soft (warning)
                  </label>
                </fieldset>
                <fieldset>
                  <legend className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Enforced by
                  </legend>
                  <label className="mt-1 flex items-center gap-1 text-xs">
                    <input type="radio" name="enforced_by" value="review" defaultChecked />
                    review
                  </label>
                  <label className="mt-1 flex items-center gap-1 text-xs">
                    <input type="radio" name="enforced_by" value="runtime" />
                    runtime
                  </label>
                  <label className="mt-1 flex items-center gap-1 text-xs">
                    <input type="radio" name="enforced_by" value="manual" />
                    manual
                  </label>
                </fieldset>
              </div>
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Capture rule
                </button>
                <a href={`/${handle}`} className="text-xs text-muted-foreground hover:underline">
                  Cancel
                </a>
              </div>
            </Form>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
