import { withClient } from "@doco/db";
import { readChangeCursor } from "~/lib/change-cursor.server";
import { docoPath } from "~/lib/db.server";
import { canReadDocoForRequest, normalizeDocoParams } from "~/lib/doco-access.server";
import { readDocoMetadata } from "~/lib/doco-metadata.server";
import { getCurrentPrincipalAsync } from "~/lib/session.server";

/**
 * /<doco-handle>/changes.json — the change cursor.
 *
 * Returns the Doco's latest audit-event id (or null). The perspective view
 * polls this on a relaxed cadence; when the cursor advances past what's
 * rendered it raises a "new version — Refresh" banner instead of reloading the
 * graph. Read-gated exactly like status.json.
 */
export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { handle } = await normalizeDocoParams(params);
  const dir = docoPath(handle);
  const meta = await readDocoMetadata(dir);
  if (!meta) {
    return Response.json({ cursor: null }, { status: 404 });
  }
  const me = await getCurrentPrincipalAsync(request);
  if (!(await canReadDocoForRequest(request, meta, me?.id ?? null))) {
    return Response.json({ cursor: null }, { status: 404 });
  }
  const cursor = await withClient((c) => readChangeCursor(c, meta.docoId));
  return Response.json({ cursor });
}
