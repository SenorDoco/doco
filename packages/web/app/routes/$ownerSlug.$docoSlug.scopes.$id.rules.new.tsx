// /<doco-handle>/scopes/<id>/rules/new — standalone rule creation for
// a scope page's Guidance / Authoring sections.

import { withClient } from "@doco/db";
import type { EntityId } from "@doco/shared";
import { Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import { parse as parseYaml } from "yaml";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import {
  LlmUnavailableError,
  classifyRuleProse,
  formatRuleClassifierError,
} from "~/lib/llm.server";
import { createRuleInDoco, reindex } from "~/lib/redeem.server";
import { listScopeDetails } from "~/lib/scope-helpers.server";

type NewRuleKind = "authoring" | "guidance";

function resolveKind(value: string | null): NewRuleKind {
  return value === "authoring" ? "authoring" : "guidance";
}

async function readScopeRaw(
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

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string; id: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { id } = params;
  const { meta, me } = await loadDocoForAdmin(request, handle);
  const raw = await readScopeRaw(meta.docoId, id);
  if (!raw) throw new Response("Scope not found", { status: 404 });
  const url = new URL(request.url);

  return {
    ownerSlug,
    docoSlug,
    handle,
    me,
    host: await loadHostConfig(),
    kind: resolveKind(url.searchParams.get("kind")),
    scope: {
      id,
      name: String(raw.name ?? id),
      icon: typeof raw.icon === "string" ? raw.icon : "",
    },
  };
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
  const { dir, meta, me } = await loadDocoForAdmin(request, handle);
  const form = await request.formData();
  const kind = resolveKind(String(form.get("kind") ?? ""));
  const prose = String(form.get("prose") ?? "").trim();
  const back = `/${handle}/scopes/${id}`;
  if (!prose) return { error: "Type the rule in your own words." };

  const raw = await readScopeRaw(meta.docoId, id);
  if (!raw) return { error: "Scope not found." };
  const scopeName = String(raw.name ?? id);
  const scopeId = id as EntityId<"scope">;
  const docoId = meta.docoId as EntityId<"doco">;
  const createdBy = (me?.id as EntityId<"principal"> | undefined) ?? null;

  try {
    if (kind === "guidance") {
      const ruleId = await createRuleInDoco({
        docoId,
        kind: "guidance",
        summary: prose,
        scopeId,
        createdBy,
      });
      await reindex(dir, meta.docoId, [ruleId]);
      return redirect(back);
    }

    const allScopeDetails = await listScopeDetails(dir);
    const classified = await classifyRuleProse({
      prose,
      scopeName,
      availableScopes: allScopeDetails.map((s) => ({ id: s.id, name: s.name })),
    });
    const authoring = classified.filter((c) => c.bucket === "authoring");
    const guidanceCount = classified.length - authoring.length;
    if (authoring.length === 0) {
      return {
        error: "This reads like guidance. Add it from the Guidance Rules section instead.",
      };
    }
    if (guidanceCount > 0) {
      return {
        error:
          "This mixes authoring and guidance rules. Submit authoring and guidance rules separately.",
      };
    }
    const changedIds: string[] = [];
    for (const c of authoring) {
      // v7: a Rule is authoring for a scope iff the scope cites it via
      // gated_by; createRuleInDoco auto-wires the citation when a
      // predicate is set.
      const ruleId = await createRuleInDoco({
        docoId,
        summary: c.text.trim() || `Authoring rule (${c.rule.kind})`,
        predicate: c.rule,
        scopeId,
        createdBy,
      });
      changedIds.push(ruleId);
    }
    await reindex(dir, meta.docoId, changedIds);
    return redirect(back);
  } catch (e) {
    if (e instanceof LlmUnavailableError) {
      return {
        error: formatRuleClassifierError(e),
      };
    }
    return { error: (e as Error).message };
  }
}

export function meta({
  params,
}: {
  params: { docoId: string; id: string };
}) {
  return [{ title: `New scope rule · ${params.docoId} · Doco` }];
}

export default function NewScopeRule({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { ownerSlug, docoSlug, handle, scope, me } = loaderData;
  const [searchParams] = useSearchParams();
  const kind = resolveKind(searchParams.get("kind") ?? loaderData.kind);
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const title = kind === "guidance" ? "New guidance rule" : "New authoring rule";
  const description =
    kind === "guidance"
      ? "Guidance rules are saved as one prose rule for contributors to read while working with this scope."
      : "Authoring rules become predicates evaluated when nodes enter this scope.";

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug, handle }} />
      <main className="mx-auto max-w-2xl px-6 py-6 space-y-4">
        <Link
          to={`/${handle}/scopes/${scope.id}`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to {scope.name}
        </Link>
        <Card>
          <CardHeader>
            <CardTitle>{title}</CardTitle>
            <CardDescription>
              {scope.icon ? <span className="mr-1">{scope.icon}</span> : null}
              <span className="font-mono">{scope.name}</span> · {description}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-4">
              <input type="hidden" name="kind" value={kind} />
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Rule prose
                </span>
                <textarea
                  name="prose"
                  required
                  rows={6}
                  placeholder={
                    kind === "guidance"
                      ? "Write the guidance exactly as contributors should read it."
                      : "Describe the authoring rule in plain English."
                  }
                  className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm"
                />
              </label>
              {actionData?.error ? (
                <p className="text-xs text-destructive">{actionData.error}</p>
              ) : null}
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="rounded-md border border-primary bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  SUBMIT
                </button>
                <Link
                  to={`/${handle}/scopes/${scope.id}`}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  Cancel
                </Link>
              </div>
            </Form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
