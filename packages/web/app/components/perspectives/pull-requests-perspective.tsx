// Pull requests perspective — a Doco's imported GitHub pull requests,
// grouped by lifecycle (Merged / Open / Closed).
//
// PRs are stored as `reference` nodes (locator = the PR URL); the loader
// (pull-requests-perspective.server.ts) reads them back and buckets them.
// Each row links out to the PR on GitHub and carries a lifecycle chip;
// color always encodes lifecycle (see ~/lib/node-colors).
//
// When the Doco has no GitHub connection, this paints an empty state that
// points at the Doco-specific GitHub connection flow.
//
// All chrome (border, background, fullscreen + lifecycle overlays) is owned
// by the PerspectiveFrame; this component only paints the content.

import { ExternalLink, GitMerge, GitPullRequest, Github } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import { lifecycleColor } from "~/lib/node-colors";
import { perspectiveCountLabel } from "~/lib/perspective-count";
import type {
  PullRequestGroup,
  PullRequestsPerspectiveData,
} from "~/lib/pull-requests-perspective.server";
import { usePerspectiveFocusScroll } from "~/lib/use-perspective-focus-scroll";

interface PullRequestsPerspectiveProps {
  data: PullRequestsPerspectiveData;
  /** Doco handle — used to link to its GitHub connection flow in the empty state. */
  handle: string;
  /**
   * Page-level lifecycle filter set. PRs whose lifecycle isn't in this set
   * are excluded before render. When omitted, every PR is shown.
   */
  visibleLifecycles?: Set<string>;
  /** Node to scroll into view and pulse — the perspective's one-shot focus. */
  focusId?: string | null;
}

export function PullRequestsPerspective({
  data,
  handle,
  visibleLifecycles,
  focusId,
}: PullRequestsPerspectiveProps) {
  usePerspectiveFocusScroll(focusId);
  const groups = useMemo(() => {
    if (!visibleLifecycles) return data.groups;
    return data.groups
      .map((group) => ({
        ...group,
        prs: group.prs.filter((pr) => visibleLifecycles.has(pr.lifecycle)),
      }))
      .filter((group) => group.prs.length > 0);
  }, [data.groups, visibleLifecycles]);

  if (!data.connected) {
    return <NotConnected handle={handle} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 pb-3 pt-12">
      <div className="flex items-center gap-2">
        {/* One honest line about the dataset: the true total of PR references
            (all lifecycles) and how many of the latest are shown when capped.
            Independent of the lifecycle filter — its effect shows in the
            per-group counts below, never here. */}
        <p className="inline-flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
          <GitPullRequest aria-hidden className="h-3.5 w-3.5" />
          {perspectiveCountLabel(
            { loaded: data.loadedCount, total: data.totalCount },
            "pull request",
          )}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {groups.length === 0 ? (
          <p className="px-4 py-3 text-xs italic text-muted-foreground">
            No imported pull requests match the current lifecycle filter.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <PullRequestGroupSection key={group.lifecycle} group={group} handle={handle} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PullRequestGroupSection({ group, handle }: { group: PullRequestGroup; handle: string }) {
  return (
    <section>
      <h3 className="flex items-center gap-2 px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: lifecycleColor(group.lifecycle) }}
          aria-hidden
        />
        {group.label}
        <span className="tabular-nums text-muted-foreground/70">{group.prs.length}</span>
      </h3>
      <ul className="divide-y divide-border rounded-md border border-border">
        {group.prs.map((pr) => (
          <li
            key={pr.id}
            className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-background"
            data-node-id={pr.id}
            data-node-href={`/${handle}/reference/${pr.id}`}
            data-node-lifecycle={pr.lifecycle}
          >
            {/* Clicking the entry opens the node dialog, like every other
                perspective. The PR URL is reached via the explicit button. */}
            <Link
              to={`/${handle}/reference/${pr.id}`}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <span aria-hidden className="shrink-0 text-muted-foreground">
                {pr.lifecycle === "asserted" ? (
                  <GitMerge className="h-3.5 w-3.5" />
                ) : (
                  <GitPullRequest className="h-3.5 w-3.5" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate" title={pr.title}>
                {pr.title}
              </span>
              <span
                className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
                style={{
                  color: lifecycleColor(pr.lifecycle),
                  borderColor: lifecycleColor(pr.lifecycle),
                }}
              >
                {group.label}
              </span>
            </Link>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-card"
              title="View this pull request on GitHub"
            >
              <Github aria-hidden className="h-3 w-3" />
              View in GitHub
              <ExternalLink aria-hidden className="h-2.5 w-2.5" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NotConnected({ handle }: { handle: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
      <Github aria-hidden className="h-9 w-9 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">No GitHub repository connected yet</p>
      <p className="max-w-md text-xs text-muted-foreground">
        Connect a GitHub repository to import its pull requests. Once connected, merged, open, and
        closed PRs show up here, grouped by lifecycle.
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
