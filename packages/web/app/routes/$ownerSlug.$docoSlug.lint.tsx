import { Link } from "react-router";
import { runAllLints } from "@doco/lints";
import { openDocoDb } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";

export function loader({
  request,
  params,
}: {
  request: Request;
  params: { ownerSlug: string; docoSlug: string };
}) {
  const { ownerSlug, docoSlug } = params;
  const db = openDocoDb(ownerSlug, docoSlug);
  try {
    const report = runAllLints(db);
    return {
      report,
      ownerSlug,
      docoSlug,
      host: loadHostConfig(),
      me: getCurrentPrincipal(request),
    };
  } finally {
    db.close();
  }
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
      <SiteHeader context={host.name} mode="host" me={me} docoScope={{ ownerSlug, docoSlug }} />
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
                        to={`/${ownerSlug}/${docoSlug}/e/${guessTypeFromId(iss.source)}/${iss.source}`}
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
