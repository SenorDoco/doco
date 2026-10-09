// One workspace at a glance: the icons of its Docos, any integration or agent
// gone unexpectedly quiet, the three things to do next (add a Doco or a source
// of knowledge, invite a person, invite an agent: the message that has it
// connect itself to Doco and start using it here, in the invite dialog) and
// when it last saw activity. The Workspaces page lists one per workspace, with
// the way back to the person's open onboarding step; each workspace's own page
// shows its card once the person's steps there are done.

import { useState } from "react";
import { Link } from "react-router";
import { Card, CardContent } from "~/components/card";
import { DocoTypeIcon } from "~/components/doco-type-icon";
import { AgentInviteDialog } from "~/components/invite-dialog";
import { SilenceAlertList } from "~/components/silence-alerts";
import { timeAgo } from "~/lib/time-ago";
import type { WorkspaceSummary } from "~/lib/workspace-summaries.server";

const BUTTON =
  "neu-button whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-semibold hover:opacity-90";

/** The onboarding step the person is on in a workspace, while one is open. */
export interface WorkspaceSetup {
  title: string;
  number: number;
  total: number;
}

export function WorkspaceSummaryCard({
  workspace,
  baseUrl,
  showName = true,
  setup,
}: {
  workspace: WorkspaceSummary;
  /** Doco's public URL, which the agent's guide and message point at. */
  baseUrl: string;
  /** The workspace's own page already names it in the header. */
  showName?: boolean;
  setup?: WorkspaceSetup;
}) {
  const member = workspace.role !== null;
  const [invitingAgent, setInvitingAgent] = useState(false);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {showName ? (
            <Link
              to={`/workspaces/${workspace.handle}`}
              className="text-lg font-semibold text-primary hover:underline"
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
                  className="neu-button neu-small flex h-7 w-7 items-center justify-center rounded-md"
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
        <SilenceAlertList alerts={workspace.alerts} />
        {setup ? (
          <Link
            to={`/workspaces/${workspace.handle}`}
            className="neu-button inline-flex flex-wrap items-baseline gap-x-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            <span>
              {setup.total > 1
                ? `Finish setting up: step ${setup.number} of ${setup.total}`
                : "One step left"}
            </span>
            <span className="font-normal opacity-90">{setup.title}</span>
          </Link>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {member ? (
            <>
              <Link
                to={`/new-doco?workspace_id=${encodeURIComponent(workspace.id)}`}
                className={BUTTON}
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
          <button type="button" onClick={() => setInvitingAgent(true)} className={BUTTON}>
            Invite agent
          </button>
        </div>
        {invitingAgent ? (
          <AgentInviteDialog
            workspaceHandle={workspace.handle}
            baseUrl={baseUrl}
            onClose={() => setInvitingAgent(false)}
          />
        ) : null}
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
