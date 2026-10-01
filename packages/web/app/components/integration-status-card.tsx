import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { refusedAccessNote } from "~/lib/github-imports";
import type {
  ConnectedIntegrationStatus,
  GitHubIntegrationStatus,
  IntegrationStatus,
} from "~/lib/integration-status.server";
import { monthYear } from "~/lib/month-year";
import { timeAgo } from "~/lib/time-ago";

// "Manage" CTA — mirrors the primary button on the Integrations index so the
// two entry points read as the same action.
export const MANAGE_BTN =
  "neu-button inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90";

export const NAMES = { github: "GitHub", slack: "Slack", notion: "Notion" } as const;
/** What connecting each source takes, for a Doco whose source isn't connected. */
export const CONNECT = {
  github: "Pick repositories",
  slack: "Connect Slack",
  notion: "Connect Notion",
} as const;

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

/** The live half: when the newest item copied from the source appeared. */
export function liveLine(status: ConnectedIntegrationStatus, now: Date): string {
  if (status.integration === "github") {
    return status.latestAt
      ? `Latest ${status.item} update ${timeAgo(status.latestAt, now)}`
      : `No ${status.items} copied yet`;
  }
  if (status.integration === "notion") {
    return status.latestAt
      ? `Newest page edit ${timeAgo(status.latestAt, now)}`
      : "No pages copied yet";
  }
  return status.latestAt
    ? `Newest message ${timeAgo(status.latestAt, now)}`
    : "No messages copied yet";
}

/** The history half: how far the import of older items has got. */
function historyLine(status: ConnectedIntegrationStatus): string {
  if (status.integration === "github") {
    const repos = `${status.reposDone} of ${status.repos} repos`;
    if (status.state === "done") {
      return status.skipped > 0
        ? `${status.skipped} of ${status.repos} repos skipped`
        : `All ${status.items} imported`;
    }
    if (status.state === "stalled") return `Import of ${status.items} stalled at ${repos}`;
    return `Importing ${status.items}: ${repos}`;
  }
  if (status.integration === "notion") {
    if (status.needsReauth) return "Notion no longer accepts the connection: reconnect to resume";
    const pages = `${status.pagesDone.toLocaleString("en-US")} of ${status.pages.toLocaleString("en-US")} pages`;
    // A capped listing is not the whole workspace: the rest arrives through
    // the pages that name it, so the counts keep growing.
    const capped = status.listingCapped ? " (listing capped by Notion)" : "";
    if (status.state === "done") {
      return status.pages === 0
        ? "Nothing shared with Doco yet"
        : `All ${status.pages.toLocaleString("en-US")} pages copied${capped}`;
    }
    if (status.state === "stalled") return `Page copy stalled at ${pages}${capped}`;
    return status.pages === 0
      ? "Discovering the pages shared with Doco"
      : `Copying pages: ${pages}${capped}`;
  }
  const since = monthYear(status.since);
  if (status.state === "done") return `All history copied back to ${since}`;
  // How far back every channel has got so far, against how far back it goes.
  const reached = status.backTo ? monthYear(status.backTo) : null;
  const dates =
    status.state === "stalled"
      ? reached
        ? `History copy stalled at ${reached} on its way back to ${since}`
        : `History copy back to ${since} stalled`
      : reached
        ? `History copied back to ${reached} so far, going back to ${since}`
        : `Copying history back to ${since}`;
  return [
    dates,
    `${status.channelsDone.toLocaleString("en-US")} of ${status.channels.toLocaleString("en-US")} channels complete`,
    ...(status.threadsPending > 0
      ? [`${status.threadsPending.toLocaleString("en-US")} threads to fetch`]
      : []),
  ].join(" · ");
}

/** Why a finished GitHub import skipped repositories, and what brings them in. */
function skippedLine(status: GitHubIntegrationStatus): string {
  return status.refused
    ? `${refusedAccessNote(status)} The import runs again once it's accepted.`
    : "GitHub didn't return them. Re-import to try again.";
}

/** A finished GitHub import that skipped repositories, or null. */
function skippedImport(status: ConnectedIntegrationStatus): GitHubIntegrationStatus | null {
  return status.integration === "github" && status.state === "done" && status.skipped > 0
    ? status
    : null;
}

/** Whether the history half has news: an import under way or stalled, or
 *  one that skipped repositories. */
export function historyNeedsSaying(status: ConnectedIntegrationStatus): boolean {
  return status.state !== "done" || skippedImport(status) !== null;
}

/** The history half: how far the import of older items has got, flagged
 *  when it stopped advancing or skipped repositories, and why. */
export function IntegrationHistory({ status }: { status: ConnectedIntegrationStatus }) {
  const skipped = skippedImport(status);
  return (
    <>
      <p
        className={`flex items-center gap-1.5 text-xs ${
          status.state === "stalled" || skipped ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        <span aria-hidden>
          {status.state === "done" && !skipped ? "✅" : status.state === "importing" ? "⏳" : "⚠️"}
        </span>
        <span>{historyLine(status)}</span>
        {status.state === "importing" ? <Spinner /> : null}
      </p>
      {skipped ? <p className="text-xs text-muted-foreground">{skippedLine(skipped)}</p> : null}
    </>
  );
}

/**
 * Box atop the activity column of a Doco that copies from a source (GitHub
 * pull requests or bugs, a Slack or Notion workspace): how live the copy is, how far the import
 * of older items has got — flagged when it stopped advancing — and a link to
 * manage the integration. A Doco made to fill from a source nobody connected
 * yet says so, with the way to connect it.
 */
export function IntegrationStatusCard({
  handle,
  status,
  now = new Date(),
}: {
  handle: string;
  status: IntegrationStatus;
  now?: Date;
}) {
  if (status.state === "unconnected") {
    return (
      <Card>
        <CardHeader className="space-y-1 px-4 py-3">
          <CardTitle className="text-sm">{NAMES[status.integration]} integration</CardTitle>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden>⚪</span>
            <span>
              <span className="font-medium text-foreground">Not connected</span> · Nothing comes
              into this doco until it is.
            </span>
          </p>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <Link to={`/${handle}/integrations/${status.integration}`} className={MANAGE_BTN}>
            {CONNECT[status.integration]}
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="space-y-1 px-4 py-3">
        <CardTitle className="text-sm">{NAMES[status.integration]} integration</CardTitle>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden>🟢</span>
          <span>
            <span className="font-medium text-foreground">Live</span> · {liveLine(status, now)}
          </span>
        </p>
        <IntegrationHistory status={status} />
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <Link to={`/${handle}/integrations/${status.integration}`} className={MANAGE_BTN}>
          Manage
        </Link>
      </CardContent>
    </Card>
  );
}
