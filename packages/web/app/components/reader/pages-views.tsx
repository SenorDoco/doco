// What the pages reader shows: a Notion Doco's home (the pages edited most
// recently, as Notion's Recents; there is no tree), a page rendered from its
// Markdown with its outline and its links beside it, or search hits. Before
// any page is copied, it says whether pages are on their way, and if not, why.
import { ExternalLink } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Link } from "react-router";
import { MANAGE_BTN } from "~/components/integration-status-card";
import { Markdown, type NotionLink, markdownOutline } from "~/components/markdown";
import { cn } from "~/lib/cn";
import type { IntegrationStatus } from "~/lib/integration-status.server";
import { notionIdFromUrl } from "~/lib/notion-markdown";
import type {
  NotionPageRef,
  NotionReaderPage,
  NotionSearchHit,
  PagesView,
} from "~/lib/notion-mirror-read.server";
import { readerHref } from "~/lib/reader";
import { timeAgo } from "~/lib/time-ago";
import { BAR, CopyLink, META, META_LINK, Marked, plural } from "./reader-parts";
import { ItemIcon } from "./reader-tree";

const SECTION_TITLE = "text-xs font-semibold uppercase tracking-wide text-muted-foreground";

const pageKind = (object: "page" | "data_source") =>
  object === "data_source" ? ("database" as const) : ("page" as const);

function PageIcon({ page }: { page: { icon: string | null; object?: "page" | "data_source" } }) {
  return <ItemIcon item={{ kind: pageKind(page.object ?? "page"), icon: page.icon }} />;
}

/** "Edited 5m ago by Ana Ruiz". */
function Edited({ at, by }: { at: string | null; by: string | null }) {
  if (!at) return null;
  return (
    <span>
      Edited <time dateTime={at}>{timeAgo(at)}</time>
      {by ? ` by ${by}` : ""}
    </span>
  );
}

/** Before any page is copied: whether pages are on their way, and if not, why. */
function NoPagesYet({ handle, status }: { handle: string; status: IntegrationStatus }) {
  const manage = `/${handle}/integrations/notion`;
  let body: ReactNode;
  if (status.state === "unconnected" || status.integration !== "notion") {
    body = (
      <>
        <p>No Notion workspace is connected, so no pages are coming in yet.</p>
        <Link to={manage} className={MANAGE_BTN}>
          Connect Notion
        </Link>
      </>
    );
  } else if (status.needsReauth || status.state !== "importing") {
    body = (
      <p className="max-w-md">
        {status.needsReauth
          ? "Notion no longer accepts the connection, so no pages are coming in."
          : status.state === "stalled"
            ? "Copying the pages stalled."
            : "Nothing in Notion is shared with Doco yet: only the pages shared with it in Notion's page picker are copied."}{" "}
        <Link to={manage} className="font-semibold text-primary">
          Manage Notion
        </Link>
      </p>
    );
  } else {
    body = (
      <p className="flex max-w-md items-center gap-2 text-left">
        <span
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
        />
        <span>The pages shared with Doco in Notion appear here as they are copied.</span>
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      {body}
    </div>
  );
}

function HomeView({
  handle,
  view,
}: {
  handle: string;
  view: Extract<PagesView, { view: "home" }>;
}) {
  return (
    <div className="p-4 sm:p-6">
      <section className="space-y-2">
        <h2 className={SECTION_TITLE}>Recently edited</h2>
        <ul className="neu-surface divide-y divide-border overflow-hidden rounded-lg">
          {view.recent.map((page) => (
            <li key={page.pageId}>
              <Link
                to={readerHref(handle, "pages", page.pageId)}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-sm hover:bg-input"
              >
                <PageIcon page={page} />
                <span className="font-medium">{page.title || "Untitled"}</span>
                {page.where ? (
                  <span className="truncate text-xs text-muted-foreground">{page.where}</span>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {page.lastEditedAt ? timeAgo(page.lastEditedAt) : null}
                  {page.lastEditedBy ? ` · ${page.lastEditedBy}` : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function RefList({
  handle,
  label,
  refs,
}: {
  handle: string;
  label: string;
  refs: NotionPageRef[];
}) {
  if (refs.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h3 className={SECTION_TITLE}>{label}</h3>
      <ul className="space-y-0.5">
        {refs.map((ref) => (
          <li key={ref.pageId}>
            <Link
              to={readerHref(handle, "pages", ref.pageId)}
              title={ref.copied ? undefined : "Not copied yet"}
              className={cn(
                "flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[13px] hover:bg-input",
                !ref.copied && "italic text-primary/60",
              )}
            >
              <PageIcon page={ref} />
              <span className="truncate">{ref.title || "Untitled"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PageView({ handle, page }: { handle: string; page: NotionReaderPage }) {
  // A link to a page the copy knows stays in the reader, copied or not (a
  // queued page explains itself); one to a page the copy lacks goes to
  // Notion, and says so.
  const copiedById = new Map(page.links.map((ref) => [ref.pageId, ref.copied]));
  const linkFor = (href: string): NotionLink => {
    const id = notionIdFromUrl(href);
    if (!id) return { href, copy: null };
    const copied = copiedById.get(id);
    if (copied === undefined) return { href, copy: "none" };
    return { href: readerHref(handle, "pages", id), copy: copied ? "copied" : "queued" };
  };
  const outline = page.copied ? markdownOutline(page.markdown, "notion") : [];
  const beside = outline.length > 0 || page.links.length > 0 || page.backlinks.length > 0;
  return (
    <article>
      <header className={BAR}>
        <nav
          aria-label="Page path"
          className="flex min-w-0 flex-wrap items-center gap-1 text-[13px] text-muted-foreground"
        >
          {page.path.map((ancestor) => (
            <Fragment key={ancestor.pageId}>
              <Link to={readerHref(handle, "pages", ancestor.pageId)} className="hover:underline">
                {ancestor.title || "Untitled"}
              </Link>
              <span aria-hidden className="text-muted-foreground/60">
                /
              </span>
            </Fragment>
          ))}
          <span className="font-semibold text-foreground">{page.title || "Untitled"}</span>
        </nav>
        <div className={META}>
          <Edited at={page.lastEditedAt} by={page.lastEditedBy} />
          <CopyLink />
          <a href={page.url} target="_blank" rel="noreferrer" className={META_LINK}>
            Open in Notion
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        </div>
      </header>
      <div
        className={cn(
          "grid gap-6 px-4 py-5 sm:px-6",
          beside && "2xl:grid-cols-[minmax(0,1fr)_14rem]",
        )}
      >
        <div className="min-w-0 max-w-3xl space-y-4">
          <h2 className="flex items-center gap-2 text-2xl font-semibold text-foreground [&_img]:h-6 [&_img]:w-6 [&_span]:w-auto [&_span]:text-2xl [&_svg]:h-6 [&_svg]:w-6">
            <PageIcon page={page} />
            {page.title || "Untitled"}
          </h2>
          {page.copied ? null : (
            <p className="neu-well rounded-md bg-input/50 p-3 text-xs text-muted-foreground">
              This page is not in the copy yet. Doco is copying pages in the background; meanwhile,
              read it{" "}
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer"
                className="font-semibold text-primary hover:underline"
              >
                in Notion
              </a>
              .
            </p>
          )}
          {page.truncated ? (
            <p className="neu-well rounded-md bg-input/50 p-3 text-xs text-muted-foreground">
              Notion returned only part of this page, so the copy ends early.
            </p>
          ) : null}
          {page.copied ? (
            <Markdown
              markdown={page.markdown}
              dialect="notion"
              linkFor={linkFor}
              className="font-serif text-[15px]"
            />
          ) : null}
        </div>
        {beside ? (
          <aside className="space-y-5 border-border max-2xl:border-t max-2xl:pt-4 2xl:sticky 2xl:top-14 2xl:self-start 2xl:border-l 2xl:pl-4">
            {outline.length > 0 ? (
              <nav aria-label="On this page" className="space-y-1.5">
                <h3 className={SECTION_TITLE}>On this page</h3>
                <ul className="space-y-0.5 text-[13px]">
                  {outline.map((entry) => (
                    <li key={entry.id} style={{ paddingLeft: (entry.level - 1) * 10 }}>
                      <a
                        href={`#${entry.id}`}
                        className="block truncate rounded px-1.5 py-0.5 hover:bg-input"
                      >
                        {entry.text}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            ) : null}
            <RefList handle={handle} label="Linked from" refs={page.backlinks} />
            <RefList handle={handle} label="Links to" refs={page.links} />
          </aside>
        ) : null}
      </div>
    </article>
  );
}

function SearchView({
  handle,
  view,
}: {
  handle: string;
  view: Extract<PagesView, { view: "search" }>;
}) {
  const { hits, query } = view;
  if (hits.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No pages match “{query}”.</p>;
  }
  return (
    <div className="space-y-3 p-4">
      <p className="text-xs">
        <b>{plural(hits.length, "page", "pages")}</b> match “{query}”
      </p>
      <ul className="neu-surface divide-y divide-border overflow-hidden rounded-lg">
        {hits.map((hit) => (
          <SearchHit key={hit.page_id} handle={handle} hit={hit} query={query} />
        ))}
      </ul>
    </div>
  );
}

function SearchHit({
  handle,
  hit,
  query,
}: {
  handle: string;
  hit: NotionSearchHit;
  query: string;
}) {
  return (
    <li className="space-y-0.5 px-3 py-2.5">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <Link
          to={readerHref(handle, "pages", hit.page_id)}
          className="text-sm font-semibold hover:underline"
        >
          {hit.title || "Untitled"}
        </Link>
        {hit.path ? <span className="text-xs text-muted-foreground">{hit.path}</span> : null}
      </p>
      {hit.copied ? (
        hit.snippet ? (
          <p className="text-[13px] text-muted-foreground [&_mark]:rounded-sm [&_mark]:bg-warning/40 [&_mark]:text-foreground">
            <Marked text={hit.snippet} query={query} />
          </p>
        ) : null
      ) : (
        <p className="text-[13px] italic text-muted-foreground">
          Not copied yet ·{" "}
          <a href={hit.url} target="_blank" rel="noreferrer" className="hover:underline">
            read it in Notion
          </a>
        </p>
      )}
    </li>
  );
}

export function PagesReaderView({
  handle,
  view,
  status,
}: {
  handle: string;
  view: PagesView;
  status: IntegrationStatus;
}) {
  if (view.view === "page") return <PageView handle={handle} page={view.page} />;
  if (view.view === "search") return <SearchView handle={handle} view={view} />;
  if (view.recent.length === 0) {
    return <NoPagesYet handle={handle} status={status} />;
  }
  return <HomeView handle={handle} view={view} />;
}
