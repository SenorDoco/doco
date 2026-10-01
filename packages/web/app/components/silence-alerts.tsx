// The open silence alerts (silence-alerts.server.ts): an integration Doco that
// stopped receiving data, or an agent that stopped reading and writing, for
// longer than its own history makes expected. Each workspace card (the
// Workspaces page and the top of each workspace's page) and each Doco they
// concern show them.

import { AlertTriangle } from "lucide-react";
import { Link } from "react-router";
import type { SilenceAlert } from "~/lib/silence-alerts.server";

const SOURCE_NAMES = { github: "GitHub", slack: "Slack", notion: "Notion" } as const;

export function SilenceAlertList({
  alerts,
  now = new Date(),
}: {
  alerts: SilenceAlert[];
  now?: Date;
}) {
  if (alerts.length === 0) return null;
  return (
    <ul
      aria-label="Alerts"
      className="space-y-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-snug"
    >
      {alerts.map((alert) => (
        <li key={alert.id} className="flex gap-2">
          <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
          <span className="min-w-0">
            <AlertLine alert={alert} now={now} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** "30 hours", "3 days": how long it has been quiet (a day at least). */
export function quietFor(at: string, now: Date): string {
  const hours = Math.max(0, Math.floor((now.getTime() - new Date(at).getTime()) / 3_600_000));
  return hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`;
}

function For({ at, now }: { at: string; now: Date }) {
  return (
    <time dateTime={at} title={`Quiet since ${at}`} suppressHydrationWarning>
      {quietFor(at, now)}
    </time>
  );
}

function AlertLine({ alert, now }: { alert: SilenceAlert; now: Date }) {
  if (alert.kind === "integration") {
    return (
      <>
        <Link to={`/${alert.docoHandle}`} className="font-semibold hover:underline">
          {alert.docoHandle}
        </Link>{" "}
        has received nothing from {SOURCE_NAMES[alert.source]} for{" "}
        <For at={alert.quietSince} now={now} />, though the same hours of each of the past four
        weeks brought about {alert.usual.toLocaleString("en-US")} updates.{" "}
        <Link
          to={`/${alert.docoHandle}/integrations/${alert.source}`}
          className="font-semibold text-primary hover:underline"
        >
          Check the connection
        </Link>
      </>
    );
  }
  return (
    <>
      <span className="font-semibold">{alert.agentName}</span>
      {alert.agentUser ? ` (@${alert.agentUser})` : null} hasn't read or written in{" "}
      <Link to={`/workspaces/${alert.workspaceHandle}`} className="font-semibold hover:underline">
        {alert.workspaceHandle}
      </Link>{" "}
      for <For at={alert.quietSince} now={now} />, though the same hours of each of the past four
      weeks saw about {alert.usual.toLocaleString("en-US")} reads and writes.
    </>
  );
}
