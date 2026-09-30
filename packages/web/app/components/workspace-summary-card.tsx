// One workspace at a glance: the icons of its Docos, the three things to do
// next (add a Doco or a source of knowledge, invite a person, invite an
// agent) and when it last saw activity. The Workspaces page lists
// one per workspace; each workspace's own page shows its card on top.

import { Link } from "react-router";
import { Card, CardContent } from "~/components/card";
import { DocoTypeIcon } from "~/components/doco-type-icon";
import { timeAgo } from "~/lib/time-ago";
import type { WorkspaceSummary } from "~/lib/workspace-summaries.server";

const BUTTON =
  "neu-button whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-semibold hover:opacity-90";

export function WorkspaceSummaryCard({
  workspace,
  showName = true,
}: {
  workspace: WorkspaceSummary;
  /** The workspace's own page already names it in the header. */
  showName?: boolean;
}) {
  const member = workspace.role !== null;
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {showName ? (
            <Link
              to={`/workspaces/${workspace.handle}`}
              className="text-sm font-semibold text-foreground hover:text-primary"
            >
              {workspace.handle}
            </Link>
          ) : null}
          <ul className="flex flex-wrap items-center gap-1.5" aria-label="Docos">
            {workspace.docos.map((doco) => (
              <li key={doco.id}>
                <Link
                  to={`/${doco.handle}`}
                  title={doco.handle}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:border-primary hover:text-foreground"
                >
                  <DocoTypeIcon template={doco.template} />
                  <span className="sr-only">{doco.handle}</span>
                </Link>
              </li>
            ))}
            {workspace.docos.length === 0 ? (
              <li className="text-xs italic text-muted-foreground">No Docos yet</li>
            ) : null}
          </ul>
        </div>
        <div className="flex flex-wrap gap-2">
          {member ? (
            <>
              <Link
                to={`/new-doco?workspace_id=${encodeURIComponent(workspace.id)}`}
                className={`${BUTTON} bg-primary text-primary-foreground`}
              >
                New Doco or source
              </Link>
              <Link
                to={`/users?scope=${encodeURIComponent(`workspace:${workspace.id}`)}`}
                className={BUTTON}
              >
                Invite person
              </Link>
            </>
          ) : null}
          <Link to={`/workspaces/${workspace.handle}/agent`} className={BUTTON}>
            Invite agent
          </Link>
        </div>
        <LastActivityLine at={workspace.lastActivityAt} />
      </CardContent>
    </Card>
  );
}

function LastActivityLine({ at }: { at: string | null }) {
  if (!at) {
    return <p className="text-xs text-muted-foreground">No activity yet.</p>;
  }
  return (
    <p className="text-xs text-muted-foreground">
      Last activity:{" "}
      <time dateTime={at} title={at} suppressHydrationWarning className="tabular-nums">
        {timeAgo(at)}
      </time>
    </p>
  );
}
