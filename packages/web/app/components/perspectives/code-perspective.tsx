// Code perspective — a codebase Doco's copy of its GitHub repositories: each
// repository's folders, the open file numbered by line, and search across
// every path and file.
//
// Data: codebase-read.server.ts (loadCodePerspective). URL state keeps it
// linkable: ?code_repo=<owner/name>&code_path=<folder or file>, ?code_q=<search>,
// and #L<n> for a line.
//
// All chrome (border, background, fullscreen) is owned by the PerspectiveFrame;
// this component only paints the content.

import { ExternalLink, FileText, Folder, Search } from "lucide-react";
import { Form, Link } from "react-router";
import { cn } from "~/lib/cn";
import type { CodeFile, CodePerspectiveData, CodeSearchHit } from "~/lib/codebase-read.server";
import type { IntegrationStatus } from "~/lib/integration-status.server";
import { timeAgo } from "~/lib/time-ago";

function codeHref(repo: string, path = ""): string {
  const params: Record<string, string> = { perspective: "code", code_repo: repo };
  if (path) params.code_path = path;
  return `?${new URLSearchParams(params).toString()}`;
}

const OMITTED: Record<NonNullable<CodeFile["omitted"]>, string> = {
  binary: "A binary file: the copy keeps its name only.",
  too_large: "Too large to copy: the copy keeps its name only.",
  unavailable: "GitHub didn't return this file's text: the copy keeps its name only.",
};

const CONNECT_BTN =
  "neu-button inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90";

/** Before any file is copied: whether code is on its way, and if not, why. */
function NoCodeYet({ handle, source }: { handle: string; source?: IntegrationStatus }) {
  const manage = `/${handle}/integrations/github`;
  if (!source || source.state === "unconnected") {
    return (
      <>
        <p>No repositories are connected, so no code is coming in yet.</p>
        <Link to={manage} className={CONNECT_BTN}>
          Pick repositories
        </Link>
      </>
    );
  }
  if (source.state === "importing" && source.integration === "github") {
    return (
      <p className="flex max-w-md items-center gap-2 text-left">
        <span
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
        />
        <span>
          Copying the code of {source.repos} {source.repos === 1 ? "repository" : "repositories"}{" "}
          from GitHub. Files appear here as they are copied.
        </span>
      </p>
    );
  }
  return (
    <p className="max-w-md">
      {source.state === "stalled"
        ? "Copying the code stalled."
        : source.integration === "github" && source.refused
          ? `GitHub hasn't given Doco's GitHub App access to the code of ${source.skipped} ${
              source.skipped === 1 ? "repository" : "repositories"
            } yet. Accept the App's request for ${source.permission} access in GitHub. The copy runs again once it's accepted.`
          : "No files came from the connected repositories."}{" "}
      <Link to={manage} className="font-semibold text-primary">
        Manage GitHub
      </Link>
    </p>
  );
}

export function CodePerspective({
  data,
  handle,
  source,
}: {
  data: CodePerspectiveData;
  handle: string;
  /** How the GitHub copy is doing, for the empty state. */
  source?: IntegrationStatus;
}) {
  if (!data.repo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <NoCodeYet handle={handle} source={source} />
      </div>
    );
  }
  const repo = data.repo;
  const searching = data.query !== "";
  return (
    <div className="flex h-full min-h-0 gap-3 px-3 pb-3 pt-12">
      <nav aria-label="Files" className="w-56 shrink-0 space-y-2 overflow-y-auto text-sm">
        {data.repos.length > 1 ? (
          <ul aria-label="Repositories" className="space-y-0.5 border-b border-border pb-2">
            {data.repos.map((r) => (
              <li key={r.repo}>
                <Link
                  to={codeHref(r.repo)}
                  className={cn(
                    "block truncate rounded px-1.5 py-1 hover:bg-input",
                    r.repo === repo
                      ? "bg-input font-semibold text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {r.repo}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        <Breadcrumb repo={repo} dir={data.dir} />
        <ul className="space-y-0.5">
          {data.entries.map((entry) => (
            <li key={entry.path}>
              <Link
                to={codeHref(repo, entry.path)}
                className={cn(
                  "flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-input",
                  !searching && entry.path === data.file?.path
                    ? "bg-input font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {entry.kind === "dir" ? (
                  <Folder aria-hidden className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <FileText aria-hidden className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="truncate">{entry.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <Form method="get" className="flex items-center gap-2">
          <input type="hidden" name="perspective" value="code" />
          <input type="hidden" name="code_repo" value={repo} />
          <input
            name="code_q"
            defaultValue={data.query}
            placeholder="Search every file"
            aria-label="Search the code"
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
          ) : data.file ? (
            <FileView file={data.file} />
          ) : (
            <p className="px-2 py-3 text-xs italic text-muted-foreground">
              Pick a file to read it.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

function Breadcrumb({ repo, dir }: { repo: string; dir: string }) {
  const parts = dir ? dir.split("/") : [];
  return (
    <p className="flex flex-wrap items-center gap-1 px-1.5 text-xs text-muted-foreground">
      <Link to={codeHref(repo)} className="font-semibold hover:text-foreground">
        {repo.split("/")[1] ?? repo}
      </Link>
      {parts.map((part, i) => (
        <span key={parts.slice(0, i + 1).join("/")} className="flex items-center gap-1">
          <span aria-hidden>/</span>
          <Link
            to={codeHref(repo, parts.slice(0, i + 1).join("/"))}
            className="hover:text-foreground"
          >
            {part}
          </Link>
        </span>
      ))}
    </p>
  );
}

function FileView({ file }: { file: CodeFile }) {
  const lines = file.content.split("\n");
  return (
    <article className="space-y-2 px-2">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="break-all font-mono text-sm font-semibold text-foreground">{file.path}</h2>
        <span className="text-xs text-muted-foreground">
          Copied <time dateTime={file.syncedAt}>{timeAgo(file.syncedAt)}</time>
        </span>
        <a
          href={file.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          View on GitHub
          <ExternalLink aria-hidden className="h-3 w-3" />
        </a>
      </header>
      {file.omitted ? (
        <p className="rounded-md border border-border bg-input/50 p-2 text-xs text-muted-foreground">
          {OMITTED[file.omitted]}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {lines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: line numbers are stable keys
                <tr key={i} id={`L${i + 1}`} className="target:bg-primary/10">
                  <td className="select-none px-2 text-right align-top text-muted-foreground">
                    {i + 1}
                  </td>
                  <td className="whitespace-pre pr-3 text-foreground">{line}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function Hits({ hits }: { hits: CodeSearchHit[] }) {
  if (hits.length === 0) {
    return <p className="px-2 py-3 text-xs italic text-muted-foreground">No files match.</p>;
  }
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {hits.map((hit) => (
        <li key={`${hit.repo}/${hit.path}`} className="p-3">
          <Link
            to={`${codeHref(hit.repo, hit.path)}${hit.line ? `#L${hit.line}` : ""}`}
            className="break-all font-mono text-sm font-semibold text-foreground hover:underline"
          >
            {hit.path}
          </Link>
          <span className="ml-2 text-xs text-muted-foreground">{hit.repo}</span>
          {hit.snippet ? (
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              <span className="mr-2 select-none">{hit.line}</span>
              {hit.snippet}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
