import { withClient } from "@doco/db";
import { runAllLints } from "@doco/lints";
import { Link } from "react-router";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { loadDocoForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const ctx = await loadDocoForRead(request, ownerSlug, docoSlug); // 404 if private + non-member
  const report = await withClient((c) => runAllLints(c, ctx.meta.docoId));
  return {
    report,
    ownerSlug,
    docoSlug,
    host: await loadHostConfig(),
    me: await getCurrentPrincipal(request),
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
  const { report, ownerSlug, docoSlug, host, me } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Lint report</CardTitle>
            <CardDescription>
              Lint is a set of structural checks Doco runs across every entity in this Doco — orphan
              references, broken <code>applies_to</code> selectors, scope-membership violations,
              lifecycle conflicts, and similar invariants from <code>SYSTEM_LINTS</code>. Errors are
              blockers (something is wrong with the graph); warnings flag drift that probably needs
              attention but won't break callers. Runs on every page load.
            </CardDescription>
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
                    <Badge variant={iss.severity === "error" ? "destructive" : "warning"}>
                      {iss.lintId}
                    </Badge>
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
