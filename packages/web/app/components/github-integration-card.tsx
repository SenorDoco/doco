import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";

// "Manage" CTA — mirrors the primary button on the Integrations index so the
// two entry points read as the same action.
const MANAGE_BTN =
  "neu-button inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90";

/**
 * Right-column box on a GitHub-connected Doco's home: confirms the integration
 * is live and, while the first PR backfill runs, that old PRs are still being
 * imported. `importing` flips false on its own as the Doco-home loader polls
 * (ADR-089), so the note clears once the import finishes without a reload.
 * Links to the GitHub integration detail page to manage repos.
 */
export function GithubIntegrationCard({
  handle,
  importing,
}: {
  handle: string;
  importing: boolean;
}) {
  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-sm">GitHub integration</CardTitle>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden>🟢</span>
          <span className="font-medium text-foreground">Active</span>
        </p>
        {importing ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Currently importing old PRs…
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent align-middle"
            />
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <Link to={`/${handle}/integrations/github`} className={MANAGE_BTN}>
          Manage
        </Link>
      </CardContent>
    </Card>
  );
}
