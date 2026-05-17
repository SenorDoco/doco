// /<owner>/<doco>/scopes/<id>/intent/replace — standalone main Intent
// replacement for a scope.

import { withClient } from "@doco/db";
import type { EntityId } from "@doco/shared";
import { entityUrl } from "@doco/shared";
import { Form, Link, redirect, useNavigation } from "react-router";
import { parse as parseYaml } from "yaml";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { updateEntity } from "~/lib/capture.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { createIntentInDoco, reindex, updateScopeInDoco } from "~/lib/redeem.server";

interface PrimaryIntentRecord {
  id: string;
  summary: string;
  lifecycle: string;
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

function scopeMainIntentId(raw: Record<string, unknown> | null): string | null {
  const ids = Array.isArray(raw?.intent_ids)
    ? raw.intent_ids.filter((id): id is string => typeof id === "string")
    : [];
  return ids.length === 1 ? ids[0] : null;
}

async function readMainIntentForScope(
  docoId: string,
  mainIntentId?: string | null,
): Promise<PrimaryIntentRecord | null> {
  if (!mainIntentId) return null;
  try {
    return await withClient(async (c) => {
      const r = await c.query<PrimaryIntentRecord>(
        `SELECT id,
                COALESCE(summary, '') AS summary,
                COALESCE(lifecycle, 'active') AS lifecycle
           FROM intents
          WHERE doco_id = $1
            AND id = $2
          LIMIT 1`,
        [docoId, mainIntentId],
      );
      return r.rows[0] ?? null;
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
  const { meta, me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const raw = await readScopeRaw(meta.docoId, id);
  if (!raw) throw new Response("Scope not found", { status: 404 });
  const primaryIntent = await readMainIntentForScope(meta.docoId, scopeMainIntentId(raw));

  return {
    ownerSlug,
    docoSlug,
    handle,
    me,
    host: await loadHostConfig(),
    scope: {
      id,
      name: String(raw.name ?? id),
      icon: typeof raw.icon === "string" ? raw.icon : "",
    },
    primaryIntent,
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
  const { dir, meta, me } = await loadDocoForAdmin(request, ownerSlug, docoSlug);
  const form = await request.formData();
  const summary = String(form.get("summary") ?? "").trim();
  const back = `/${handle}/scopes/${id}`;
  if (!summary) return { error: "Main intent is required." };

  const raw = await readScopeRaw(meta.docoId, id);
  if (!raw) return { error: "Scope not found." };
  const existingPrimaryId = scopeMainIntentId(raw);
  const actorId = (me?.id ??
    (meta.ownerId.startsWith("principal_") ? meta.ownerId : null)) as EntityId<"principal"> | null;
  const scopeId = id as EntityId<"scope">;
  const newIntentId = await createIntentInDoco({
    docoId: meta.docoId as EntityId<"doco">,
    summary,
    scopeId,
    createdBy: actorId,
  });

  if (existingPrimaryId && existingPrimaryId !== newIntentId) {
    const current = await readMainIntentForScope(meta.docoId, existingPrimaryId);
    if (current && current.lifecycle !== "abandoned") {
      const result = await updateEntity({
        docoDir: dir,
        docoId: meta.docoId,
        ownerSlug,
        docoSlug,
        nodeType: "intent",
        pluralDir: "intents",
        id: existingPrimaryId,
        patch: { lifecycle: "abandoned" },
        allowedFields: ["lifecycle"],
        docoHost: new URL(request.url).origin,
        actorId,
      });
      if ("error" in result) return { error: result.error };
    }
  }

  await updateScopeInDoco({
    docoDir: dir,
    scopeId,
    intentIds: [newIntentId],
  });
  await reindex(dir, meta.docoId, [id, newIntentId]);
  return redirect(back);
}

export function meta({
  params,
}: {
  params: { docoId: string; id: string };
}) {
  return [
    { title: `Replace intent · ${params.id} · ${params.docoId} · Doco` },
  ];
}

export default function ReplaceScopeIntentPage({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { ownerSlug, docoSlug, handle, scope, primaryIntent, me } = loaderData;
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

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
            <CardTitle>Replace main intent</CardTitle>
            <CardDescription>
              {scope.icon ? <span className="mr-1">{scope.icon}</span> : null}
              <span className="font-mono">{scope.name}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {primaryIntent ? (
              <p className="mb-4 text-sm text-muted-foreground">
                Current:{" "}
                <Link
                  to={entityUrl({
                    ownerSlug,
                    docoSlug,
                    nodeType: "intent",
                    id: primaryIntent.id,
                  })}
                  className="text-foreground hover:text-primary"
                >
                  {primaryIntent.summary}
                </Link>
                {primaryIntent.lifecycle !== "active" ? (
                  <span className="ml-2">
                    <Badge>{primaryIntent.lifecycle}</Badge>
                  </span>
                ) : null}
              </p>
            ) : null}
            <Form method="post" className="space-y-4">
              <label className="block">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Main intent
                </span>
                <textarea
                  name="summary"
                  required
                  rows={6}
                  defaultValue={primaryIntent?.summary ?? ""}
                  className="mt-1 block w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
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
                  Replace
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
