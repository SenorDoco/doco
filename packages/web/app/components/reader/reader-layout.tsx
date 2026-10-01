// The reader's frame, around whatever it shows (a folder, a file, a page, a
// search): the Doco's name and kind with one status line for its copy, one
// search box, and a codebase's tree, which turns into a drawer on a phone.
// "/" focuses the search.
import { ListTree, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { DocoTypeIcon } from "~/components/doco-type-icon";
import {
  CONNECT,
  IntegrationHistory,
  MANAGE_BTN,
  NAMES,
  historyNeedsSaying,
  liveLine,
} from "~/components/integration-status-card";
import { PageHeader } from "~/components/page-header";
import { VisibilityIcon } from "~/components/visibility-icon";
import { cn } from "~/lib/cn";
import { findDocoTemplateMeta } from "~/lib/doco-templates-meta";
import type { IntegrationStatus } from "~/lib/integration-status.server";
import { type ReaderKind, type ReaderListing, readerHref } from "~/lib/reader";
import { ReaderSearch } from "./reader-search";
import { ReaderTree } from "./reader-tree";

/** What the reader's frame shows, whatever is open in it. */
export interface ReaderShell {
  handle: string;
  reader: ReaderKind;
  template: string;
  ownerSlug: string;
  ownerIsWorkspace: boolean;
  visibility: "private" | "public";
  goal: string;
  /** Whether the viewer may open the Doco's settings. */
  canAdmin: boolean;
  /** How the copy from the Doco's source is doing. */
  status: IntegrationStatus;
  /** A codebase tree's first listings: the top (""), and the open item's
   *  place. Null for a Notion copy, which has no tree. */
  tree: Record<string, ReaderListing> | null;
}

const OUTLINE_BTN =
  "neu-button inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input";

const count = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** How much the copy holds: repositories and files, or a workspace's pages. */
function copied(shell: ReaderShell): string | null {
  const { status } = shell;
  if (status.state === "unconnected") return null;
  if (status.integration === "notion") {
    return `${status.workspaceName} · ${count(status.pagesDone, "page", "pages")}`;
  }
  const top = shell.tree?.[""] ?? { items: [], more: 0 };
  const files = top.items.reduce((sum, item) => sum + (item.files ?? 0), 0);
  return `${count(top.items.length + top.more, "repository", "repositories")} · ${count(files, "file", "files")}`;
}

function StatusLine({ shell, now }: { shell: ReaderShell; now: Date }) {
  const { status } = shell;
  if (status.state === "unconnected") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden className="h-2 w-2 rounded-full bg-muted-foreground/40" />
        <span>
          <span className="font-medium text-foreground">Not connected</span> · Nothing comes into
          this doco until it is.
        </span>
      </p>
    );
  }
  const amount = copied(shell);
  return (
    <div className="space-y-0.5">
      <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span aria-hidden className="h-2 w-2 rounded-full bg-success ring-[3px] ring-success/20" />
        <span className="font-medium text-foreground">Live</span>
        {amount ? <span>· {amount}</span> : null}
        <span>· {liveLine(status, now)}</span>
      </p>
      {historyNeedsSaying(status) ? <IntegrationHistory status={status} /> : null}
    </div>
  );
}

/** Whether a key press is someone typing, which shortcuts leave alone. */
function typing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return (
    !!target &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export function ReaderLayout({
  shell,
  trail,
  query,
  now = new Date(),
  children,
}: {
  shell: ReaderShell;
  /** The open item's place in the tree. */
  trail: string[];
  /** The search, "" when browsing. */
  query: string;
  now?: Date;
  children: ReactNode;
}) {
  const { handle, reader, status } = shell;
  const location = useLocation();
  const searchRef = useRef<HTMLInputElement>(null);
  const [drawer, setDrawer] = useState(false);

  // Following a link closes the phone's drawer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: closes on every move
  useEffect(() => setDrawer(false), [location.pathname, location.search]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event)) return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const integration = status.integration;
  const kind = findDocoTemplateMeta(shell.template)?.label ?? null;

  return (
    <main className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-5 sm:px-6 sm:pb-6">
      <PageHeader
        className="mb-4 shrink-0"
        breadcrumb={[
          { label: "Home", to: "/" },
          {
            label: shell.ownerSlug,
            to: shell.ownerIsWorkspace
              ? `/workspaces/${shell.ownerSlug}`
              : `/users/${shell.ownerSlug}`,
          },
          { label: handle, to: readerHref(handle, reader) },
        ]}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <DocoTypeIcon template={shell.template} className="h-5 w-5" />
            <Link to={readerHref(handle, reader)} className="hover:text-primary">
              {handle}
            </Link>
            <VisibilityIcon visibility={shell.visibility} />
            {kind ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] font-semibold tracking-normal text-muted-foreground">
                {kind}
              </span>
            ) : null}
          </span>
        }
        actions={
          <>
            {status.state === "unconnected" ? (
              <Link to={`/${handle}/integrations/${integration}`} className={MANAGE_BTN}>
                {CONNECT[integration]}
              </Link>
            ) : (
              <Link to={`/${handle}/integrations/${integration}`} className={OUTLINE_BTN}>
                Manage {NAMES[integration]}
              </Link>
            )}
            {shell.canAdmin ? (
              <Link to={`/${handle}/settings`} className={OUTLINE_BTN}>
                Settings
              </Link>
            ) : null}
          </>
        }
      >
        <StatusLine shell={shell} now={now} />
        {shell.goal ? <p className="text-[11px] text-muted-foreground">{shell.goal}</p> : null}
      </PageHeader>

      <section className="neu-surface flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg bg-card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          {shell.tree ? (
            <button
              type="button"
              onClick={() => setDrawer(true)}
              className={cn(OUTLINE_BTN, "md:hidden")}
              aria-label="Show the files"
            >
              <ListTree aria-hidden className="h-3.5 w-3.5" />
              Files
            </button>
          ) : null}
          <ReaderSearch handle={handle} reader={reader} query={query} inputRef={searchRef} />
          {query ? (
            <Link to={location.pathname} className={OUTLINE_BTN}>
              Close search
            </Link>
          ) : null}
        </div>
        {shell.tree ? (
          <div className="relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] md:grid-cols-[280px_minmax(0,1fr)]">
            {drawer ? (
              <button
                type="button"
                aria-label="Close"
                onClick={() => setDrawer(false)}
                className="fixed inset-0 z-40 bg-foreground/20 md:hidden"
              />
            ) : null}
            <aside
              className={cn(
                "min-h-0 flex-col border-r border-border bg-card",
                drawer
                  ? "fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-xs shadow-xl md:static md:z-auto md:w-auto md:max-w-none md:shadow-none"
                  : "hidden md:flex",
              )}
            >
              {drawer ? (
                <div className="flex items-center justify-between px-3 pt-3 md:hidden">
                  <span className="text-xs font-semibold">Files</span>
                  <button
                    type="button"
                    onClick={() => setDrawer(false)}
                    aria-label="Hide the files"
                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                  >
                    <X aria-hidden className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
              <ReaderTree
                handle={handle}
                listings={shell.tree}
                trail={trail}
                current={query ? null : (trail.at(-1) ?? "")}
                onNavigate={() => setDrawer(false)}
              />
            </aside>
            <div className="min-h-0 min-w-0 overflow-auto">{children}</div>
          </div>
        ) : (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</div>
        )}
      </section>
    </main>
  );
}
