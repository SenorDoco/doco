// GET /<doco-handle>/api/audit.json — read the per-Doco audit log.
//
// Filters (all optional, all query-string):
//   entity_id=<id>           events for one entity
//   entity_type=<type>       events for one node type
//   op=<op>[,<op>,...]       comma-separated op-type filter
//   by=<user_id>        events authored by a given Principal
//   since=<ISO8601>          inclusive lower bound (event.at >= since)
//   before=<ISO8601>         exclusive pagination cursor (event.at < before)
//   until=<ISO8601>          inclusive upper bound (event.at <= until)
//   limit=<int>              cap response size (default 200, max 1000)
//
// Response: `{ ok, count, events: AuditEvent[] }` newest-first.

import { type AuditOp, readAuditEvents } from "~/lib/audit-log.server";
import { docoPath } from "~/lib/db.server";
import { canReadDocoForRequest, normalizeDocoParams } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/doco-metadata.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

const VALID_OPS: ReadonlySet<string> = new Set([
  "entity.create",
  "entity.update",
  "entity.delete",
  "lifecycle.transition",
  "edge.add",
]);

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const dir = docoPath(handle);
  const meta = await readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ error: `Doco "${handle}" not found.` }, { status: 404 });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (!(await canReadDocoForRequest(request, meta, me?.id ?? null))) {
    return Response.json({ error: `Doco "${handle}" not found.` }, { status: 404 });
  }

  const url = new URL(request.url);
  const entity_id = url.searchParams.get("entity_id") ?? undefined;
  const entity_type = url.searchParams.get("entity_type") ?? undefined;
  const by = url.searchParams.get("by") ?? undefined;
  const since = url.searchParams.get("since") ?? undefined;
  const before = url.searchParams.get("before") ?? undefined;
  const until = url.searchParams.get("until") ?? undefined;
  const opParam = url.searchParams.get("op");
  let op: AuditOp[] | undefined;
  if (opParam) {
    const parts = opParam
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const invalid = parts.filter((p) => !VALID_OPS.has(p));
    if (invalid.length > 0) {
      return Response.json(
        {
          error: `Invalid op value(s): ${invalid.join(", ")}. Allowed: ${[...VALID_OPS].join(", ")}.`,
        },
        { status: 400 },
      );
    }
    op = parts as AuditOp[];
  }
  const limitRaw = url.searchParams.get("limit");
  let limit = 200;
  if (limitRaw) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1) {
      return Response.json({ error: "limit must be a positive integer." }, { status: 400 });
    }
    limit = Math.min(n, 1000);
  }

  const events = await readAuditEvents(
    dir,
    {
      entity_id,
      entity_type,
      by,
      op,
      since,
      before,
      until,
      limit,
    },
    meta.docoId,
  );
  return Response.json({ ok: true, count: events.length, events });
}
