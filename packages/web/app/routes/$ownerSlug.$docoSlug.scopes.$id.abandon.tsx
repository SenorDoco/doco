// /<owner>/<doco>/scopes/<id>/abandon — standalone Danger Zone for
// abandoning a scope.
//
// Per decision_01KRPNZY7W6CCMYNKGND67BP0B the destructive action moved
// off the merged scope page so the main scope page stays a coherent
// "edit everything else" surface. Reaching this page requires clicking
// through from /scopes/<id>; non-empty scopes still require typing the
// name verbatim to confirm.

import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import type { EntityId } from "@doco/shared";
import { parse as parseYaml } from "yaml";
import { withClient } from "@doco/db";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { reindex, updateScopeInDoco } from "~/lib/redeem.server";
import { listScopeDetails, readDocoMetadata } from "~/lib/scope-helpers.server";

async function readScopeRaw(scopeId: string): Promise<Record<string, unknown> | null> {
  try {
    return await withClient(async (c) => {
      const r = await c.query<{ raw_yaml: string }>(
        "SELECT raw_yaml FROM scopes WHERE id = $1 LIMIT 1",
        [scopeId],
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
  const { dir, me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const raw = await readScopeRaw(id);
  if (!raw) throw new Response("Scope not found", { status: 404 });
  const scopeName = String(raw.name);
  const lifecycle = typeof raw.lifecycle === "string" ? raw.lifecycle : "active";

  const meta = await readDocoMetadata(dir);
  const docoId = meta?.docoId ?? null;
  const allScopeDetails = await listScopeDetails(dir);
  const childNames = allScopeDetails.filter((s) => s.parent_ids.includes(id)).map((s) => s.name);

  let memberCount = 0;
  if (docoId) {
    try {
      memberCount = await withClient(async (c) => {
        const r = await c.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM edges
            WHERE to_id = $1 AND edge_type = 'in_scope_of'
              AND from_node_type != 'scope' AND doco_id = $2`,
          [id, docoId],
        );
        return Number(r.rows[0]?.n ?? 0);
      });
    } catch {
      /* index not built yet */
    }
  }

  return {
    ownerSlug,
    docoSlug,
    handle,
    me,
    host: await loadHostConfig(),
    scope: { id, name: scopeName, lifecycle },
    childNames,
    memberCount,
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
  const { dir } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const scopeId = id as EntityId<"scope">;
  const back = `/${handle}/scopes`;

  try {
    if (intent === "abandon") {
      const raw = await readScopeRaw(id);
      if (!raw) return { error: "Scope not found." };
      if (raw.name === "global") {
        return {
          error:
            "The Global scope (the doco's constitution) cannot be abandoned — it's a framework-seeded invariant.",
        };
      }
      const scopeName = String(raw.name);

      const allScopeDetails = await listScopeDetails(dir);
      const children = allScopeDetails.filter((s) => s.parent_ids.includes(id));
      if (children.length > 0) {
        return {
          error: `Can't abandon: ${children.length} child scope(s) depend on this. Reparent or abandon them first: ${children.map((s) => s.name).join(", ")}`,
        };
      }

      const meta = await readDocoMetadata(dir);
      let memberCount = 0;
      try {
        if (meta?.docoId) {
          memberCount = await withClient(async (c) => {
            const r = await c.query<{ n: string }>(
              `SELECT COUNT(*)::text AS n FROM edges
                WHERE to_id = $1 AND edge_type = 'in_scope_of'
                  AND from_node_type != 'scope' AND doco_id = $2`,
              [id, meta.docoId],
            );
            return Number(r.rows[0]?.n ?? 0);
          });
        }
      } catch {
        /* index not built yet */
      }

      if (memberCount > 0) {
        const confirmName = String(form.get("confirm_name") ?? "").trim();
        if (confirmName !== scopeName) {
          return {
            error: `Type the scope name "${scopeName}" exactly to confirm abandoning a non-empty scope.`,
          };
        }
      }

      await updateScopeInDoco({ docoDir: dir, scopeId, lifecycle: "abandoned" });
    } else if (intent === "activate") {
      await updateScopeInDoco({ docoDir: dir, scopeId, lifecycle: "active" });
    } else {
      return { error: `Unknown intent: ${intent}` };
    }
  } catch (e) {
    return { error: (e as Error).message };
  }

  await reindex(dir);
  return redirect(back);
}

export function meta({ params }: { params: { docoId: string; id: string } }) {
  return [{ title: `Abandon · ${params.id} · ${params.docoId} · Doco` }];
}

export default function AbandonScopePage({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { ownerSlug, docoSlug, handle, scope, childNames, memberCount, me } = loaderData;
  const [typed, setTyped] = useState("");
  const hasChildren = childNames.length > 0;
  const hasMembers = memberCount > 0;
  const isAbandoned = scope.lifecycle !== "active" && scope.lifecycle !== "proposed";
  const canSubmit = !hasChildren && (!hasMembers || typed.trim() === scope.name);

  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-2xl px-6 py-6 space-y-4">
        {actionData?.error ? (
          <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {actionData.error}
          </div>
        ) : null}

        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-bold tracking-tight">
            Abandon scope · <span className="font-mono">{scope.name}</span>
          </h1>
          <Link
            to={`/${handle}/scopes/${scope.id}`}
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            ← Back to scope
          </Link>
        </div>

        {isAbandoned ? (
          <Card className="border-warn/40">
            <CardHeader>
              <CardTitle className="text-sm">This scope is already abandoned</CardTitle>
              <CardDescription>
                Existing members keep their tag, but new captures referencing it are rejected.
                Activate it to start accepting new members again.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Form method="post">
                <input type="hidden" name="intent" value="activate" />
                <button
                  type="submit"
                  className="rounded-md border border-border bg-input px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-card"
                >
                  Activate scope
                </button>
              </Form>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-sm text-destructive">Danger zone</CardTitle>
              <CardDescription>
                Abandoning a scope keeps existing members tagged and queryable, but new captures
                referencing this scope are rejected. Scopes are never deleted; abandoning is the
                closest you get to "remove."
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {hasChildren ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  Can't abandon:{" "}
                  {childNames.length === 1
                    ? "1 child scope depends"
                    : `${childNames.length} child scopes depend`}{" "}
                  on this one — {childNames.map((n) => `\`${n}\``).join(", ")}. Reparent or
                  abandon them first.
                </div>
              ) : (
                <Form method="post" className="space-y-3">
                  <input type="hidden" name="intent" value="abandon" />
                  {hasMembers ? (
                    <>
                      <p className="text-xs text-foreground">
                        This scope has <span className="font-semibold">{memberCount}</span>{" "}
                        {memberCount === 1 ? "node" : "nodes"} tagged with it. To confirm
                        abandonment, type the scope name{" "}
                        <span className="font-mono font-semibold">{scope.name}</span> below.
                      </p>
                      <label className="block">
                        <span className="mb-1 block text-[11px] uppercase tracking-wider text-muted-foreground">
                          Type the scope name to confirm
                        </span>
                        <input
                          name="confirm_name"
                          value={typed}
                          onChange={(e) => setTyped(e.target.value)}
                          autoComplete="off"
                          placeholder={scope.name}
                          className="w-full rounded-md border border-destructive/40 bg-input px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-destructive"
                        />
                      </label>
                    </>
                  ) : (
                    <p className="text-xs text-foreground">
                      This scope is empty — no nodes are tagged with it. Press the button below to
                      abandon it. (You can activate it later.)
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="rounded-md bg-destructive px-3 py-1.5 text-xs font-semibold text-destructive-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {hasMembers ? "Abandon scope" : "Abandon empty scope"}
                  </button>
                </Form>
              )}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
