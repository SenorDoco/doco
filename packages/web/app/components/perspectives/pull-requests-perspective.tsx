// Pull requests perspective — a Doco's imported GitHub pull requests as a
// flat, newest-first list (every stage interleaved — Merged / Open / Closed —
// NOT grouped by lifecycle). The frame's lifecycle filter narrows the list by
// PR state (Open / Merged / Closed); the narrowing happens server-side (see the
// loader) so it spans the whole repo, not just the latest-N slice shown here.
// The list opens with the latest 50; Show more loads 50 more (`?pr_limit=`).
//
// PRs are stored as `reference` nodes (locator = the PR URL); the loader
// (pull-requests-perspective.server.ts) reads the latest back. Each row links
// out to the PR on GitHub and carries a lifecycle chip; color encodes lifecycle
// (see ~/lib/node-colors).
//
// When the Doco has no GitHub connection, this paints an empty state that
// points at the Doco-specific GitHub connection flow.
//
// All chrome (border, background, fullscreen + lifecycle overlays) is owned
// by the PerspectiveFrame; this component only paints the content.

import { ExternalLink, GitMerge, GitPullRequest, Github } from "lucide-react";
import { Link } from "react-router";
import { ShowMoreLink } from "~/components/show-more-link";
import { lifecycleColor } from "~/lib/node-colors";
import { perspectiveCountLabel } from "~/lib/perspective-count";
import type {
  PullRequestItem,
  PullRequestsPerspectiveData,
} from "~/lib/pull-requests-perspective.server";
import { timeAgo } from "~/lib/time-ago";
import { usePerspectiveFocusScroll } from "~/lib/use-perspective-focus-scroll";

interface PullRequestsPerspectiveProps {
  data: PullRequestsPerspectiveData;
  /** Doco handle — used to link to its GitHub connection flow in the empty state. */
  handle: string;
  /** Node to scroll into view and pulse — the perspective's one-shot focus. */
  focusId?: string | null;
  /**
   * True when the lifecycle filter is narrowing the list (a strict subset of
   * stages is selected). Lets the empty state distinguish "nothing matches the
   * filter" from "no PRs imported yet".
   */
  filtered?: boolean;
}

export function PullRequestsPerspective({
  data,
  handle,
  focusId,
  filtered = false,
}: PullRequestsPerspectiveProps) {
  usePerspectiveFocusScroll(focusId);

  if (!data.connected) {
    return <NotConnected handle={handle} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3 pt-12">
      <div className="flex items-center gap-2">
        {/* One honest line about the dataset: the true total of PR references
            (all stages) and how many of the latest are shown when capped. */}
        <p className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          <GitPullRequest aria-hidden className="h-3.5 w-3.5" />
          {perspectiveCountLabel(
            { loaded: data.loadedCount, total: data.totalCount },
            "pull request",
          )}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {data.items.length === 0 ? (
          <p className="px-4 py-3 text-xs italic text-muted-foreground">
            {filtered
              ? "No pull requests match the selected stages."
              : "No pull requests have been imported yet."}
          </p>
        ) : (
          <ul className="neu-surface divide-y divide-border rounded-md">
            {data.items.map((pr) => (
              <PullRequestRow key={pr.id} pr={pr} handle={handle} />
            ))}
          </ul>
        )}
        {data.hasMore ? <ShowMoreLink param="pr_limit" limit={data.loadedCount} /> : null}
      </div>
    </div>
  );
}

function PullRequestRow({ pr, handle }: { pr: PullRequestItem; handle: string }) {
  const label = pr.label;
  return (
    <li
      className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-background"
      data-node-id={pr.id}
      data-node-href={`/${handle}/reference/${pr.id}`}
      data-node-lifecycle={pr.lifecycle}
    >
      {/* Clicking the entry opens the node dialog, like every other
          perspective. The PR URL is reached via the explicit button. */}
      <Link to={`/${handle}/reference/${pr.id}`} className="flex min-w-0 flex-1 items-center gap-3">
        <span aria-hidden className="shrink-0 text-muted-foreground">
          {pr.lifecycle === "active" ? (
            <GitMerge className="h-3.5 w-3.5" />
          ) : (
            <GitPullRequest className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-line break-words" title={pr.title}>
          {pr.title}
        </span>
        <time
          dateTime={pr.updatedAt ?? undefined}
          title={pr.updatedAt ?? undefined}
          suppressHydrationWarning
          className="w-16 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground"
        >
          {timeAgo(pr.updatedAt)}
        </time>
        <span
          className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
          style={{ color: lifecycleColor(pr.lifecycle), borderColor: lifecycleColor(pr.lifecycle) }}
        >
          {label}
        </span>
      </Link>
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className="neu-button neu-small inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px]"
        title="View this pull request on GitHub"
      >
        <Github aria-hidden className="h-3 w-3" />
        View in GitHub
        <ExternalLink aria-hidden className="h-2.5 w-2.5" />
      </a>
    </li>
  );
}

function NotConnected({ handle }: { handle: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <Github aria-hidden className="h-9 w-9 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">No GitHub repository connected yet</p>
      <p className="max-w-md text-xs text-muted-foreground">
        Connect a GitHub repository to import its pull requests. Once connected, merged, open, and
        closed PRs show up here, newest first.
      </p>
      <Link
        to={`/${handle}/integrations/github`}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
      >
        <Github aria-hidden className="h-3.5 w-3.5" />
        Connect a GitHub repository
      </Link>
    </div>
  );
}
