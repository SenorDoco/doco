// Notion perspective — a Notion-mirror Doco's read-only copy of the pages
// and databases its workspace shares: the page tree, the open page rendered
// from its Markdown, and full-text search across every page.
//
// Data: notion-mirror-read.server.ts (loadNotionPerspective). URL state keeps
// it linkable: ?notion_page=<id>, ?notion_q=<search>.
//
// All chrome (border, background, fullscreen) is owned by the PerspectiveFrame;
// this component only paints the content.

import { ChevronDown, ChevronRight, Database, ExternalLink, FileText, Search } from "lucide-react";
import { Form, Link } from "react-router";
import { type NotionLink, NotionMarkdown } from "~/components/notion-markdown";
import { cn } from "~/lib/cn";
import { notionIdFromUrl } from "~/lib/notion-markdown";
import type {
  NotionPageRef,
  NotionPerspectiveData,
  NotionReaderPage,
  NotionSearchHit,
  NotionTreeNode,
} from "~/lib/notion-mirror-read.server";
import { timeAgo } from "~/lib/time-ago";

function perspectiveHref(params: Record<string, string>): string {
  return `?${new URLSearchParams({ perspective: "notion", ...params }).toString()}`;
}

const pageHref = (pageId: string) => perspectiveHref({ notion_page: pageId });

export function NotionPerspective({
  data,
  handle,
}: {
  data: NotionPerspectiveData;
  handle: string;
}) {
  if (data.workspaceName === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        <p>
          This Doco doesn&apos;t mirror a Notion workspace yet.{" "}
          <Link to={`/${handle}/integrations/notion`} className="font-semibold text-primary">
            Set up the Notion mirror
          </Link>
        </p>
      </div>
    );
  }
  const searching = data.query !== "";
  return (
    <div className="flex h-full min-h-0 gap-3 px-3 pb-3 pt-12">
      <nav aria-label="Notion pages" className="w-56 shrink-0 overflow-y-auto text-sm">
        <Tree nodes={data.tree} openId={searching ? null : (data.page?.pageId ?? null)} depth={0} />
        {data.moreRoots > 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">{data.moreRoots} more pages</p>
        ) : null}
      </nav>
      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <Form method="get" className="flex items-center gap-2">
          <input type="hidden" name="perspective" value="notion" />
          <input
            name="notion_q"
            defaultValue={data.query}
            placeholder="Search every page"
            aria-label="Search Notion pages"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          <button
            type="submit"
            aria-label="Search"
            className="neu-button rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
          >
            <Search aria-hidden className="h-4 w-4" />
          </button>
        </Form>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {searching ? (
            <Hits hits={data.hits} />
          ) : data.page ? (
            <PageView page={data.page} />
          ) : (
            <p className="px-2 py-3 text-xs italic text-muted-foreground">
              No pages copied yet — the pages shared with Doco in Notion appear here as they are
              copied.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function PageIcon({ icon, object }: { icon: string | null; object: "page" | "data_source" }) {
  if (icon && /^https?:\/\//i.test(icon)) {
    return <img src={icon} alt="" className="h-4 w-4 shrink-0 rounded-sm" />;
  }
  if (icon) {
    return (
      <span aria-hidden className="w-4 shrink-0 text-center">
        {icon}
      </span>
    );
  }
  const Icon = object === "data_source" ? Database : FileText;
  return <Icon aria-hidden className="h-3.5 w-3.5 shrink-0" />;
}

function Tree({
  nodes,
  openId,
  depth,
}: {
  nodes: NotionTreeNode[];
  openId: string | null;
  depth: number;
}) {
  return (
    <ul className={cn("space-y-0.5", depth > 0 && "ml-3 border-l border-border pl-1")}>
      {nodes.map((node) => (
        <li key={node.pageId}>
          <Link
            to={pageHref(node.pageId)}
            title={node.copied ? undefined : "Not copied yet"}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-1 hover:bg-input",
              node.pageId === openId
                ? "bg-input font-semibold text-foreground"
                : "text-muted-foreground",
              !node.copied && "italic",
            )}
          >
            {node.hasChildren ? (
              node.children ? (
                <ChevronDown aria-hidden className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight aria-hidden className="h-3 w-3 shrink-0" />
              )
            ) : (
              <span aria-hidden className="w-3 shrink-0" />
            )}
            <PageIcon icon={node.icon} object={node.object} />
            <span className="truncate">{node.title || "Untitled"}</span>
          </Link>
          {node.children && node.children.length > 0 ? (
            <Tree nodes={node.children} openId={openId} depth={depth + 1} />
          ) : null}
          {node.more > 0 ? (
            <p className="ml-6 px-1.5 py-0.5 text-xs text-muted-foreground">{node.more} more</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function PageView({ page }: { page: NotionReaderPage }) {
  // A link to a page the copy knows stays in the reader, copied or not (a
  // queued page explains itself); one to a page the copy lacks goes to
  // Notion, and says so.
  const copiedById = new Map(page.links.map((ref) => [ref.pageId, ref.copied]));
  const linkFor = (href: string): NotionLink => {
    const id = notionIdFromUrl(href);
    if (!id) return { href, copy: null };
    const copied = copiedById.get(id);
    if (copied === undefined) return { href, copy: "none" };
    return { href: pageHref(id), copy: copied ? "copied" : "queued" };
  };
  return (
    <article className="space-y-3 px-2">
      {page.path.length > 0 ? (
        <nav
          aria-label="Page path"
          className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
        >
          {page.path.map((ancestor, i) => (
            <span key={ancestor.pageId} className="flex items-center gap-1">
              {i > 0 ? <span aria-hidden>/</span> : null}
              <Link to={pageHref(ancestor.pageId)} className="hover:text-foreground">
                {ancestor.title || "Untitled"}
              </Link>
            </span>
          ))}
        </nav>
      ) : null}
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-xl font-semibold text-foreground">
          <PageIcon icon={page.icon} object={page.object} />
          {page.title || "Untitled"}
        </h2>
        <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
          {page.lastEditedAt ? (
            <span>
              Edited <time dateTime={page.lastEditedAt}>{timeAgo(page.lastEditedAt)}</time>
              {page.lastEditedBy ? ` by ${page.lastEditedBy}` : ""}
            </span>
          ) : null}
          <a
            href={page.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            Open in Notion
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        </p>
      </header>
      {page.copied ? null : (
        <p className="rounded-md border border-border bg-input/50 p-2 text-xs text-muted-foreground">
          This page is not in the copy yet. Doco is copying pages in the background; meanwhile, read
          it{" "}
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
        <p className="rounded-md border border-border bg-input/50 p-2 text-xs text-muted-foreground">
          Notion returned only part of this page, so the copy ends early.
        </p>
      ) : null}
      {page.copied ? <NotionMarkdown markdown={page.markdown} linkFor={linkFor} /> : null}
      <RefList label="Links to" refs={page.links} />
      <RefList label="Linked from" refs={page.backlinks} />
    </article>
  );
}

function RefList({ label, refs }: { label: string; refs: NotionPageRef[] }) {
  if (refs.length === 0) return null;
  return (
    <section className="space-y-1 border-t border-border pt-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{label}</h3>
      <ul className="flex flex-wrap gap-1.5">
        {refs.map((ref) => (
          <li key={ref.pageId}>
            <Link
              to={pageHref(ref.pageId)}
              title={ref.copied ? undefined : "Not copied yet"}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs hover:bg-input",
                !ref.copied && "italic text-muted-foreground",
              )}
            >
              {ref.icon && !/^https?:\/\//i.test(ref.icon) ? (
                <span aria-hidden>{ref.icon}</span>
              ) : null}
              {ref.title || "Untitled"}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Hits({ hits }: { hits: NotionSearchHit[] }) {
  if (hits.length === 0) {
    return <p className="px-2 py-3 text-xs italic text-muted-foreground">No Notion pages match.</p>;
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {hits.map((hit) => (
        <li key={hit.page_id} className="p-3">
          <Link
            to={pageHref(hit.page_id)}
            className="font-semibold text-foreground hover:underline"
          >
            {hit.title || "Untitled"}
          </Link>
          {hit.path ? <span className="ml-2 text-xs text-muted-foreground">{hit.path}</span> : null}
          {hit.copied ? (
            <p className="mt-1 text-sm text-muted-foreground">{hit.snippet}</p>
          ) : (
            <p className="mt-1 text-sm italic text-muted-foreground">
              Not copied yet ·{" "}
              <a href={hit.url} target="_blank" rel="noreferrer" className="hover:underline">
                read it in Notion
              </a>
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
