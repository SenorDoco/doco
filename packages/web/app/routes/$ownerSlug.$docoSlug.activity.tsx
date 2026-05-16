// /<owner>/<doco>/activity — paginated audit-events firehose.
// Reads from the per-Doco audit log (decision_01KRKESCBTYG4005VMPKYNYR53)
// with filterable query params: entity_type, op, by, since, until, limit.

import { entityUrl } from "@doco/shared";
import type { EntityId } from "@doco/shared";
import { Link } from "react-router";
import { NodeTypeBadge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { shouldStrikeActivityTarget } from "~/lib/activity-feed";
import { type AuditOp, readAuditEvents } from "~/lib/audit-log.server";
import { cn } from "~/lib/cn";
import { docoPath } from "~/lib/db.server";
import { loadDocoForRead } from "~/lib/doco-access.server";

const VALID_OPS: ReadonlySet<string> = new Set([
  "entity.create",
  "entity.update",
  "entity.delete",
  "lifecycle.transition",
  "edge.add",
]);

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `Activity · ${params.ownerSlug}/${params.docoSlug} · Doco` }];
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const { me } = await loadDocoForRead(request, ownerSlug, docoSlug);
  const dir = docoPath(ownerSlug, docoSlug);

  const url = new URL(request.url);
  const entity_type = url.searchParams.get("entity_type") ?? undefined;
  const by = url.searchParams.get("by") ?? undefined;
  const since = url.searchParams.get("since") ?? undefined;
  const until = url.searchParams.get("until") ?? undefined;
  const opParam = url.searchParams.get("op");
  let op: AuditOp[] | undefined;
  if (opParam) {
    const parts = opParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.every((p) => VALID_OPS.has(p))) op = parts as AuditOp[];
  }
  const limitRaw = url.searchParams.get("limit");
  let limit = 100;
  if (limitRaw) {
    const n = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, 1000);
  }

  const events = await readAuditEvents(dir, { entity_type, by, op, since, until, limit });
  return {
    ownerSlug,
    docoSlug,
    me,
    events,
    filters: { entity_type, by, since, until, op: opParam },
  };
}

export default function ActivityPage({
  loaderData,
}: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { ownerSlug, docoSlug, me, events, filters } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-7xl space-y-4 px-6 py-6">
        <div>
          <h1 className="text-xl font-semibold">Activity</h1>
          <p className="text-sm text-muted-foreground">
            Per-Doco audit-events log — every mutation that touched an entity. Filter via URL
            params:{" "}
            <code className="font-mono">
              ?entity_type=decision&op=lifecycle.transition&since=2026-05-01
            </code>
            .
          </p>
        </div>

        <FilterChips filters={filters} ownerSlug={ownerSlug} docoSlug={docoSlug} />

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Events ({events.length})</CardTitle>
            <CardDescription>
              Newest first. Each event captures who, when, and the before/after delta.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events match the current filters.</p>
            ) : (
              <ol className="space-y-3 text-xs">
                {events.map((e) => (
                  <li key={e.event_id} className="border-l-2 border-border pl-3">
                    <div className="text-muted-foreground">
                      <code className="font-mono">{e.at.replace("T", " ").slice(0, 19)}Z</code>
                      <span className="mx-2">·</span>
                      <code className="font-mono">{e.by ?? "anonymous"}</code>
                      <span className="mx-2">·</span>
                      <span className="font-medium text-foreground">{e.op}</span>
                      <span className="mx-2">·</span>
                      <Link
                        to={entityUrl({
                          ownerSlug,
                          docoSlug,
                          nodeType: e.entity_type as never,
                          id: e.entity_id as EntityId<never>,
                        })}
                        className={cn(
                          "inline-flex items-center gap-1.5 text-primary hover:underline",
                          shouldStrikeActivityTarget(e) && "line-through decoration-2",
                        )}
                      >
                        <NodeTypeBadge nodeType={e.entity_type} />
                        <span className="font-mono">{e.entity_id}</span>
                      </Link>
                    </div>
                    {e.before || e.after ? (
                      <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-input p-2 text-[11px] leading-snug">
                        {JSON.stringify({ before: e.before, after: e.after }, null, 2)}
                      </pre>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function FilterChips({
  filters,
  ownerSlug,
  docoSlug,
}: {
  filters: {
    entity_type?: string;
    by?: string;
    since?: string;
    until?: string;
    op?: string | null;
  };
  ownerSlug: string;
  docoSlug: string;
}) {
  const entries = Object.entries(filters).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Filters:</span>
      {entries.map(([k, v]) =>
        k === "entity_type" ? (
          <span
            key={k}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-mono"
          >
            <span>entity_type=</span>
            <NodeTypeBadge nodeType={String(v)} />
          </span>
        ) : (
          <code key={k} className="rounded-md border border-border px-2 py-0.5 font-mono">
            {k}={String(v)}
          </code>
        ),
      )}
      <Link to={`/${ownerSlug}/${docoSlug}/activity`} className="text-primary hover:underline">
        Clear
      </Link>
    </div>
  );
}
