import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import type { IntegrationStatus } from "~/lib/integration-status.server";
import { timeAgo } from "~/lib/time-ago";

// "Manage" CTA — mirrors the primary button on the Integrations index so the
// two entry points read as the same action.
const MANAGE_BTN =
  "neu-button inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90";

const NAMES = { github: "GitHub", slack: "Slack", notion: "Notion" } as const;

function monthYear(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

/** The live half: when the newest item copied from the source appeared. */
function liveLine(status: IntegrationStatus, now: Date): string {
  if (status.integration === "github") {
    return status.latestAt
      ? `Latest PR update ${timeAgo(status.latestAt, now)}`
      : "No pull requests copied yet";
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
function historyLine(status: IntegrationStatus): string {
  if (status.integration === "github") {
    const repos = `${status.reposDone} of ${status.repos} repos`;
    if (status.state === "done") return "All past PRs imported";
    if (status.state === "stalled") return `Old-PR import stalled at ${repos}`;
    return `Importing old PRs: ${repos}`;
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
  const progress = [
    status.backTo ? `back to ${monthYear(status.backTo)} of ${since}` : "starting",
    `${status.channelsDone} of ${status.channels} channels complete`,
    ...(status.threadsPending > 0
      ? [`${status.threadsPending.toLocaleString("en-US")} threads to fetch`]
      : []),
  ].join(" · ");
  return status.state === "stalled"
    ? `History copy stalled: ${progress}`
    : `Copying history: ${progress}`;
}

/**
 * Box atop the activity column of a Doco that copies from a source (GitHub
 * pull requests, a Slack or Notion workspace): how live the copy is, how far the import
 * of older items has got — flagged when it stopped advancing — and a link to
 * manage the integration.
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
        <p
          className={`flex items-center gap-1.5 text-xs ${
            status.state === "stalled" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          <span aria-hidden>
            {status.state === "done" ? "✅" : status.state === "stalled" ? "⚠️" : "⏳"}
          </span>
          <span>{historyLine(status)}</span>
          {status.state === "importing" ? <Spinner /> : null}
        </p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <Link to={`/${handle}/integrations/${status.integration}`} className={MANAGE_BTN}>
          Manage
        </Link>
      </CardContent>
    </Card>
  );
}
