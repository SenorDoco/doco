import { Link } from "react-router";
import type { CurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

/**
 * CoverageView — shared rendering for /<owner>/<doco>/coverage (ADR-090).
 *
 * Lives as a component (not a route helper) so the route file can stay minimal
 * and other routes / fixtures can reuse the view.
 */
export function CoverageView({
  report,
  context,
  me,
  docoScope,
}: {
  report: { modified: string[]; covered: string[]; uncovered: string[] };
  context: string;
  me?: CurrentPrincipal | null;
  docoScope: { ownerSlug: string; docoSlug: string };
}) {
  const total = report.modified.length;
  const uncovered = report.uncovered.length;
  const covered = report.covered.length;
  return (
    <div>
      <SiteHeader context={context} mode="host" docoScope={docoScope} me={me ?? null} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Coverage</CardTitle>
            <CardDescription>
              Files modified in the working tree, cross-referenced against every Action body
              (ADR-090). Uncovered files are drift candidates — work that shipped without an
              Action recording it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3 text-sm">
              <Badge variant="default">Modified: {total}</Badge>
              <Badge variant="success">Covered: {covered}</Badge>
              <Badge variant={uncovered === 0 ? "success" : "warning"}>
                Uncovered: {uncovered}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {uncovered === 0 ? (
          total === 0 ? (
            <Card>
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                Working tree clean — nothing to check.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-6 text-center text-sm text-muted-foreground">
                All modified files appear in at least one Action.
              </CardContent>
            </Card>
          )
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Uncovered files</CardTitle>
              <CardDescription>
                Capture the work as an Action under{" "}
                <Link
                  to={`/${docoScope.ownerSlug}/${docoScope.docoSlug}/e/action`}
                  className="text-primary hover:underline"
                >
                  actions/
                </Link>{" "}
                — verb + outputs + these file paths.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-0.5 text-xs font-mono">
                {report.uncovered.map((f) => (
                  <li key={f} className="px-2 py-0.5 hover:bg-input rounded">
                    {f}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
