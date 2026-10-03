// What the code reader shows in the middle: a codebase Doco's repositories,
// a folder as a grid of its entries above its README, a file colored by
// token with a link on every line, or search matches grouped by file. Before
// any code is copied, it says whether code is on its way, and if not, why.
import { ExternalLink, File } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { MANAGE_BTN } from "~/components/integration-status-card";
import { Markdown, type NotionLink } from "~/components/markdown";
import { cn } from "~/lib/cn";
import type { CodeLine, TokenClass } from "~/lib/code-highlight.server";
import type { CodeFile, CodeSearchHit, CodeView } from "~/lib/codebase-read.server";
import type { IntegrationStatus } from "~/lib/integration-status.server";
import { type ReaderTreeItem, githubTreeUrl, readerHref } from "~/lib/reader";
import { timeAgo } from "~/lib/time-ago";
import { BAR, CopyLink, META, META_LINK, Marked, plural } from "./reader-parts";
import { ItemIcon } from "./reader-tree";

const OMITTED: Record<NonNullable<CodeFile["omitted"]>, string> = {
  binary: "A binary file: the copy keeps its name only.",
  too_large: "Too large to copy: the copy keeps its name only.",
  unavailable: "GitHub didn't return this file's text: the copy keeps its name only.",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A link in a repository's Markdown, as the reader's own address when it
 *  points at another file of the repository. */
function codeLinkFor(handle: string, repo: string, dir: string) {
  return (href: string): NotionLink => {
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) return { href, copy: null };
    const [target, hash = ""] = href.split("#");
    const path = target.split("?")[0];
    const parts = path.startsWith("/") ? [] : dir.split("/").filter(Boolean);
    for (const segment of path.split("/")) {
      if (segment === "..") parts.pop();
      else if (segment && segment !== ".") parts.push(segment);
    }
    const at = readerHref(handle, "code", [repo, ...parts].join("/"));
    return { href: hash ? `${at}#${hash}` : at, copy: null };
  };
}

/** The way up: the repository, then each folder, the last one in bold. */
function Crumbs({ handle, repo, path }: { handle: string; repo: string; path: string }) {
  const parts = path.split("/").filter(Boolean);
  return (
    <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-1 text-[13px]">
      {parts.length === 0 ? (
        <span className="font-semibold text-foreground">{repo}</span>
      ) : (
        <Link to={readerHref(handle, "code", repo)} className="hover:underline">
          {repo}
        </Link>
      )}
      {parts.map((part, i) => {
        const id = [repo, ...parts.slice(0, i + 1)].join("/");
        return (
          <Fragment key={id}>
            <span aria-hidden className="text-muted-foreground/60">
              /
            </span>
            {i === parts.length - 1 ? (
              <span className="break-all font-semibold text-foreground">{part}</span>
            ) : (
              <Link to={readerHref(handle, "code", id)} className="hover:underline">
                {part}
              </Link>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/** Before any file is copied: whether code is on its way, and if not, why. */
function NoCodeYet({ handle, status }: { handle: string; status: IntegrationStatus }) {
  const manage = `/${handle}/integrations/github`;
  let body: ReactNode;
  if (status.state === "unconnected" || status.integration !== "github") {
    body = (
      <>
        <p>No repositories are connected, so no code is coming in yet.</p>
        <Link to={manage} className={MANAGE_BTN}>
          Pick repositories
        </Link>
      </>
    );
  } else if (status.state === "importing") {
    body = (
      <p className="flex max-w-md items-center gap-2 text-left">
        <span
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
        />
        <span>
          Copying the code of {plural(status.repos, "repository", "repositories")} from GitHub.
          Files appear here as they are copied.
        </span>
      </p>
    );
  } else {
    body = (
      <p className="max-w-md">
        {status.state === "stalled"
          ? "Copying the code stalled."
          : status.refused
            ? `GitHub hasn't given Doco's GitHub App access to the code of ${plural(
                status.skipped,
                "repository",
                "repositories",
              )} yet. Accept the App's request for ${status.permission} access in GitHub. The copy runs again once it's accepted.`
            : "No files came from the connected repositories."}{" "}
        <Link to={manage} className="font-semibold text-primary">
          Manage GitHub
        </Link>
      </p>
    );
  }
  return (
    <div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      {body}
    </div>
  );
}

/** Folders and files as a compact grid, folders with their file counts. */
function EntryGrid({ handle, items }: { handle: string; items: ReaderTreeItem[] }) {
  return (
    <ul className="neu-surface grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-0.5 rounded-lg p-3">
      {items.map((item) => (
        <li key={item.id} className="min-w-0">
          <Link
            to={readerHref(handle, "code", item.id)}
            className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-[13px] hover:bg-input"
          >
            <ItemIcon item={item} />
            <span className="truncate">{item.name}</span>
            {item.files !== null && item.kind !== "file" ? (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {item.kind === "repo" ? plural(item.files, "file", "files") : item.files}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function MarkdownCard({
  handle,
  repo,
  path,
  markdown,
}: {
  handle: string;
  repo: string;
  path: string;
  markdown: string;
}) {
  const dir = path.split("/").slice(0, -1).join("/");
  return (
    <article className="neu-surface overflow-hidden rounded-lg">
      <header className="flex items-center gap-2 border-b border-border bg-input/50 px-4 py-2 text-xs font-semibold">
        <File aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
        <Link to={readerHref(handle, "code", `${repo}/${path}`)} className="hover:underline">
          {path.split("/").pop()}
        </Link>
      </header>
      <Markdown
        markdown={markdown}
        dialect="github"
        linkFor={codeLinkFor(handle, repo, dir)}
        className="max-w-3xl px-6 py-5 font-serif text-[15px]"
      />
    </article>
  );
}

const TOKEN_CLASS: Record<TokenClass, string> = {
  c: "tok-c",
  s: "tok-s",
  k: "tok-k",
  t: "tok-t",
  n: "tok-n",
  f: "tok-f",
  g: "tok-g",
};

function Line({ line }: { line: CodeLine }) {
  return (
    <>
      {line.map((run, i) =>
        typeof run === "string" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs never move within a line
          <Fragment key={i}>{run}</Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs never move within a line
          <span key={i} className={TOKEN_CLASS[run[0]]}>
            {run[1]}
          </span>
        ),
      )}
    </>
  );
}

function FileView({
  handle,
  view,
}: {
  handle: string;
  view: Extract<CodeView, { view: "file" }>;
}) {
  const { file, lines, markdown } = view;
  const { hash } = useLocation();
  const [target, setTarget] = useState<number | null>(null);
  const [raw, setRaw] = useState(false);
  // The line the address names lights up, and a Markdown file shows its
  // lines to show it.
  useEffect(() => {
    const line = /^#L(\d+)$/.exec(hash);
    setTarget(line ? Number(line[1]) : null);
    if (line) {
      setRaw(true);
      requestAnimationFrame(() =>
        document.getElementById(`L${line[1]}`)?.scrollIntoView({ block: "center" }),
      );
    }
  }, [hash]);
  const preview = markdown !== null && !raw;
  const dir = file.path.split("/").slice(0, -1).join("/");
  return (
    <article>
      <header className={BAR}>
        <Crumbs handle={handle} repo={file.repo} path={file.path} />
        <div className={META}>
          {markdown !== null ? (
            <span className="inline-flex gap-1">
              {(["Preview", "Raw"] as const).map((label) => {
                const on = (label === "Raw") === raw;
                return (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setRaw(label === "Raw")}
                    className={cn(
                      "neu-button neu-small rounded-md px-2 py-0.5 text-[11px]",
                      on && "neu-pressed",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </span>
          ) : null}
          {file.omitted ? null : <span>{plural(lines.length, "line", "lines")}</span>}
          <span>{formatSize(file.size)}</span>
          <span>
            copied <time dateTime={file.syncedAt}>{timeAgo(file.syncedAt)}</time>
          </span>
          <CopyLink />
          <a href={file.url} target="_blank" rel="noreferrer" className={META_LINK}>
            GitHub
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        </div>
      </header>
      {file.omitted ? (
        <p className="neu-well m-4 rounded-md bg-input/50 p-3 text-xs text-muted-foreground">
          {OMITTED[file.omitted]}
        </p>
      ) : preview ? (
        <Markdown
          markdown={markdown}
          dialect="github"
          linkFor={codeLinkFor(handle, file.repo, dir)}
          className="max-w-3xl px-6 py-5 font-serif text-[15px]"
        />
      ) : (
        <table className="w-full border-collapse font-mono text-[13px] leading-5">
          <tbody>
            {lines.map((line, i) => {
              const n = i + 1;
              return (
                <tr
                  key={n}
                  id={`L${n}`}
                  className={cn("scroll-mt-16", n === target && "bg-warning/25")}
                >
                  <td className="w-px select-none whitespace-nowrap py-0 pl-4 pr-3 text-right align-top">
                    <a
                      href={`#L${n}`}
                      onClick={() => setTarget(n)}
                      className={cn(
                        "text-primary/60",
                        n === target && "font-semibold text-primary",
                      )}
                    >
                      {n}
                    </a>
                  </td>
                  <td className="whitespace-pre py-0 pr-6 text-foreground">
                    <Line line={line} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </article>
  );
}

function FolderView({
  handle,
  view,
}: {
  handle: string;
  view: Extract<CodeView, { view: "folder" }>;
}) {
  return (
    <div>
      <header className={BAR}>
        <Crumbs handle={handle} repo={view.repo} path={view.dir} />
        <div className={META}>
          <a
            href={githubTreeUrl(view.repo, view.dir)}
            target="_blank"
            rel="noreferrer"
            className={META_LINK}
          >
            GitHub
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        </div>
      </header>
      <div className="space-y-4 p-4">
        <EntryGrid handle={handle} items={view.entries} />
        {view.more > 0 ? (
          <p className="text-xs text-muted-foreground">
            {plural(view.more, "more entry", "more entries")} not listed.
          </p>
        ) : null}
        {view.readme ? (
          <MarkdownCard
            handle={handle}
            repo={view.repo}
            path={view.readme.path}
            markdown={view.readme.markdown}
          />
        ) : null}
      </div>
    </div>
  );
}

const extensionOf = (path: string) => /\.[^./]+$/.exec(path)?.[0].toLowerCase() ?? "";

function SearchView({
  handle,
  view,
}: {
  handle: string;
  view: Extract<CodeView, { view: "search" }>;
}) {
  const [only, setOnly] = useState<string | null>(null);
  const { hits, query } = view;
  if (hits.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No files match “{query}”.</p>;
  }
  const types = [...new Set(hits.map((hit) => extensionOf(hit.path)).filter(Boolean))].sort();
  const shown = only === null ? hits : hits.filter((hit) => extensionOf(hit.path) === only);
  const matches = hits.reduce((sum, hit) => sum + hit.matchCount, 0);
  const chip = (label: string, value: string | null) => (
    <button
      key={label}
      type="button"
      aria-pressed={only === value}
      onClick={() => setOnly(value)}
      className={cn(
        "neu-button neu-small rounded-full px-2.5 py-0.5 text-[11px]",
        only === value && "neu-pressed",
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span>
          <b>{plural(matches, "match", "matches")}</b> in {plural(hits.length, "file", "files")}
        </span>
        {types.length > 1 ? (
          <span className="flex flex-wrap gap-1.5">
            {chip("All files", null)}
            {types.map((type) => chip(type, type))}
          </span>
        ) : null}
      </div>
      <ul className="space-y-3">
        {shown.map((hit) => (
          <SearchHit key={`${hit.repo}/${hit.path}`} handle={handle} hit={hit} query={query} />
        ))}
      </ul>
    </div>
  );
}

function SearchHit({ handle, hit, query }: { handle: string; hit: CodeSearchHit; query: string }) {
  const href = readerHref(handle, "code", `${hit.repo}/${hit.path}`);
  const slash = hit.path.lastIndexOf("/");
  const rest = hit.matchCount - hit.matches.length;
  return (
    <li className="neu-surface overflow-hidden rounded-lg">
      <div className="flex flex-wrap items-center gap-x-2 border-b border-border bg-input/50 px-3 py-1.5 text-xs">
        <File aria-hidden className="h-3.5 w-3.5 text-muted-foreground" />
        <Link to={href} className="font-semibold hover:underline">
          {hit.path.slice(slash + 1)}
        </Link>
        <span className="text-muted-foreground">
          {hit.repo}
          {slash > 0 ? `/${hit.path.slice(0, slash)}` : ""}
        </span>
        <span className="ml-auto text-muted-foreground">
          {hit.matchCount > 0 ? plural(hit.matchCount, "match", "matches") : "Matches by name"}
        </span>
      </div>
      {hit.matches.length > 0 ? (
        <ul className="divide-y divide-border font-mono text-[12.5px]">
          {hit.matches.map((match) => (
            <li key={match.line}>
              <Link
                to={`${href}#L${match.line}`}
                className="flex gap-3 px-3 py-1 hover:bg-input [&_mark]:rounded-sm [&_mark]:bg-warning/40 [&_mark]:text-foreground"
              >
                <span className="w-8 shrink-0 text-right text-muted-foreground">{match.line}</span>
                <span className="truncate">
                  <Marked text={match.text} query={query} />
                </span>
              </Link>
            </li>
          ))}
          {rest > 0 ? (
            <li className="px-3 py-1 pl-14 text-xs text-muted-foreground">
              {plural(rest, "more match", "more matches")} in this file
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function ReposView({ handle, repos }: { handle: string; repos: ReaderTreeItem[] }) {
  return (
    <div className="space-y-3 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Repositories
      </h2>
      <EntryGrid handle={handle} items={repos} />
    </div>
  );
}

export function CodeReaderView({
  handle,
  view,
  status,
}: {
  handle: string;
  view: CodeView;
  /** How the GitHub copy is doing, for a Doco with no code yet. */
  status: IntegrationStatus;
}) {
  switch (view.view) {
    case "repos":
      return view.repos.length === 0 ? (
        <NoCodeYet handle={handle} status={status} />
      ) : (
        <ReposView handle={handle} repos={view.repos} />
      );
    case "folder":
      return <FolderView handle={handle} view={view} />;
    case "file":
      return <FileView handle={handle} view={view} />;
    case "search":
      return <SearchView handle={handle} view={view} />;
  }
}
