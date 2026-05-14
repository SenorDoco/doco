import { Link } from "react-router";
import { withClient } from "@doco/db";
import { runAllLints } from "@doco/lints";
import { docoPath } from "~/lib/db.server";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { getWatcherStatus } from "~/lib/auto-reindex.server";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const ctx = await loadDocoForRead(request, ownerSlug, docoSlug); // 404 if private + non-member
  const docoRoot = docoPath(ownerSlug, docoSlug);
  const report = await withClient((c) =>
    runAllLints(c, ctx.meta.docoId, { docoRoot }),
  );
  const watcher = getWatcherStatus();
  const docoKey = `${ownerSlug}/${docoSlug}`;
  const watcherForThisDoco = {
    enabled: watcher.enabled,
    started_at: watcher.started_at,
    pending: watcher.pending.filter((p) => p.docoKey === docoKey),
    recent: watcher.recent.filter((r) => r.docoKey === docoKey).slice(0, 10),
    total_reindexes: watcher.total_reindexes,
  };
  return {
    report,
    ownerSlug,
    docoSlug,
    host: await loadHostConfig(),
    me: await getCurrentPrincipal(request),
    watcher: watcherForThisDoco,
  };
}

export function meta({ params }: { params: { ownerSlug: string; docoSlug: string } }) {
  return [{ title: `Lint · ${params.ownerSlug}/${params.docoSlug}` }];
}

export default function LintInDoco({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { report, ownerSlug, docoSlug, host, me, watcher } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Lint report</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Badge variant={report.errors === 0 ? "success" : "destructive"}>
                {report.errors} errors
              </Badge>
              <Badge variant={report.warnings === 0 ? "success" : "warning"}>
                {report.warnings} warnings
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Auto-reindex watcher status (per `auto-reindex-on-file-changes` ADR). */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Index freshness</CardTitle>
            <CardDescription>
              The filesystem watcher reindexes this Doco whenever YAML or
              markdown changes on disk. Agents shouldn't need to call
              reindex; if this card shows the index lagging, file a bug.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Watcher</dt>
              <dd>
                {watcher.enabled ? (
                  <Badge variant="success">running</Badge>
                ) : (
                  <Badge variant="destructive">stopped</Badge>
                )}
              </dd>
              <dt className="text-muted-foreground">Started</dt>
              <dd className="font-mono">{watcher.started_at ?? "—"}</dd>
              <dt className="text-muted-foreground">Pending</dt>
              <dd>{watcher.pending.length}</dd>
              <dt className="text-muted-foreground">Reindexes (host-wide)</dt>
              <dd>{watcher.total_reindexes}</dd>
            </dl>
            {watcher.recent.length > 0 ? (
              <details className="mt-2 text-[11px]">
                <summary className="cursor-pointer text-muted-foreground">
                  Recent reindex events for this Doco ({watcher.recent.length})
                </summary>
                <ul className="mt-1 space-y-0.5 font-mono">
                  {watcher.recent.map((r, i) => (
                    <li key={`${r.ran_at}-${i}`} className={r.ok ? "text-muted-foreground" : "text-destructive"}>
                      {r.ran_at} · {r.duration_ms}ms · {r.ok ? "ok" : `error: ${r.error}`}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>lint</TableHead>
                  <TableHead>status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {Object.entries(report.issuesByLint).map(([name, issues]) => (
                  <TableRow key={name}>
                    <TableCell className="font-mono text-xs">{name}</TableCell>
                    <TableCell>
                      {issues.length === 0 ? (
                        <Badge variant="success">clean</Badge>
                      ) : (
                        <Badge variant="destructive">{issues.length} issue(s)</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {report.issues.length > 0 ? (
              <ul className="mt-4 space-y-2">
                {report.issues.map((iss) => (
                  <li key={`${iss.lintId}-${iss.source}`} className="flex items-start gap-2">
                    <Badge variant={iss.severity === "error" ? "destructive" : "warning"}>{iss.lintId}</Badge>
                    <div className="text-sm">
                      <Link
                        to={`/${ownerSlug}/${docoSlug}/${guessTypeFromId(iss.source)}/${iss.source}`}
                        className="text-primary hover:underline"
                      >
                        {iss.source}
                      </Link>
                      <div className="text-xs text-muted-foreground">{iss.message}</div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function guessTypeFromId(id: string): string {
  const m = /^([a-z]+)_/.exec(id);
  return m ? (m[1] as string) : "";
}
