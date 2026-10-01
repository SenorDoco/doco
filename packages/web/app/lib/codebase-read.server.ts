// Reading a codebase Doco's copy of its repositories (codebase-sync): the code
// reader (its tree, Go to file, a folder with its README, a file colored by
// token, search) and code results in the Doco's search. Search is full text
// over paths and file contents, matching identifiers as written. Everything
// here is scoped to one Doco; callers have already checked that the viewer
// can read it.
import { type CodeLine, highlightLines } from "./code-highlight.server";
import {
  type ReaderListing,
  type ReaderTreeItem,
  codeTrail,
  githubFileUrl,
  listingsAlong,
  splitCodeId,
} from "./reader";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

/** A line of a file that names a search term. */
export interface CodeMatch {
  /** 1-based. */
  line: number;
  /** The line, trimmed and cut to snippet length. */
  text: string;
}

export interface CodeSearchHit {
  type: "code_file";
  repo: string;
  path: string;
  url: string;
  /** The first lines naming the first search term; empty when only the path matched. */
  matches: CodeMatch[];
  /** Every line naming it. */
  matchCount: number;
}

/** A copied file, without its text. */
export interface CodeFile {
  repo: string;
  path: string;
  url: string;
  size: number;
  /** Why the copy keeps the file by name only; null when it holds the text. */
  omitted: "binary" | "too_large" | "unavailable" | null;
  syncedAt: string;
}

/** What the code reader shows at an address. `trail` is the open item's
 *  place in the tree, empty when nothing in it is open. */
export type CodeView =
  | { view: "repos"; repos: ReaderTreeItem[]; trail: string[] }
  | {
      view: "folder";
      repo: string;
      /** "" for the repository's root. */
      dir: string;
      entries: ReaderTreeItem[];
      more: number;
      readme: { path: string; markdown: string } | null;
      trail: string[];
    }
  | {
      view: "file";
      file: CodeFile;
      lines: CodeLine[];
      /** A Markdown file's text, for its preview; null for any other file. */
      markdown: string | null;
      trail: string[];
    }
  | { view: "search"; query: string; hits: CodeSearchHit[]; trail: string[] };

const ENTRY_LIMIT = 1000;
const SNIPPET_WIDTH = 200;
const MATCHES_PER_FILE = 3;
const MARKDOWN_RE = /\.(md|markdown|mdx)$/i;
const README_RE = /^readme(\.(md|markdown|txt))?$/i;

/** The search terms a match looks for: the words of the query, lowercased. */
function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^["-]+|"+$/g, ""))
    .filter((term) => term.length > 1);
}

/** Code files matching `query` by path or content, best first, each with
 *  the first lines naming the first search term. Empty for a Doco that
 *  copies no code. */
export async function searchCodebase(
  c: QueryClient,
  docoId: string,
  query: string,
  limit: number,
): Promise<CodeSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const term = searchTerms(q)[0] ?? q.toLowerCase();
  const rows = (
    await c.query<{
      repo: string;
      path: string;
      line: number | null;
      text: string | null;
      total: number | null;
    }>(
      `WITH q AS (SELECT websearch_to_tsquery('simple', $2) AS tsq),
            hits AS (
              SELECT f.repo, f.path, f.content,
                     strpos(lower(f.path), lower($2)) > 0 AS by_path,
                     ts_rank(f.search_tsv, q.tsq) AS rank
                FROM code_files f, q
               WHERE f.doco_id = $1
                 AND (f.search_tsv @@ q.tsq OR strpos(lower(f.path), lower($2)) > 0)
               ORDER BY by_path DESC, rank DESC, f.repo, f.path
               LIMIT $4)
       SELECT h.repo, h.path, m.line::int AS line, m.text, m.total::int AS total
         FROM hits h
         LEFT JOIN LATERAL (
           SELECT l.n AS line, left(btrim(l.text), ${SNIPPET_WIDTH}) AS text,
                  count(*) OVER () AS total
             FROM string_to_table(h.content, E'\\n') WITH ORDINALITY AS l(text, n)
            WHERE strpos(lower(l.text), $3) > 0
            ORDER BY l.n
            LIMIT ${MATCHES_PER_FILE}) m ON true
        ORDER BY h.by_path DESC, h.rank DESC, h.repo, h.path, m.line`,
      [docoId, q, term, limit],
    )
  ).rows;
  const hits = new Map<string, CodeSearchHit>();
  for (const row of rows) {
    const key = `${row.repo}/${row.path}`;
    let hit = hits.get(key);
    if (!hit) {
      hit = {
        type: "code_file",
        repo: row.repo,
        path: row.path,
        url: githubFileUrl(row.repo, row.path),
        matches: [],
        matchCount: Number(row.total ?? 0),
      };
      hits.set(key, hit);
    }
    if (row.line !== null && row.text !== null) {
      hit.matches.push({ line: Number(row.line), text: row.text });
    }
  }
  return [...hits.values()];
}

/** The repositories in the copy, with their file counts. */
async function listRepos(c: QueryClient, docoId: string): Promise<ReaderTreeItem[]> {
  const rows = (
    await c.query<{ repo: string; files: number }>(
      `SELECT repo, count(*)::int AS files FROM code_files
        WHERE doco_id = $1 GROUP BY repo ORDER BY repo`,
      [docoId],
    )
  ).rows;
  return rows.map((row) => ({
    id: row.repo,
    name: row.repo,
    kind: "repo",
    icon: null,
    hasChildren: true,
    files: Number(row.files),
    pending: false,
    where: "",
  }));
}

/** The folders and files directly inside `dir` of `repo` ("" for its root),
 *  folders first, each folder with the files under it. */
async function listDir(
  c: QueryClient,
  docoId: string,
  repo: string,
  dir: string,
): Promise<ReaderListing> {
  const prefix = dir ? `${dir}/` : "";
  const rows = (
    await c.query<{ name: string; is_dir: boolean; files: number; total: number }>(
      `SELECT name, is_dir, files, count(*) OVER ()::int AS total
         FROM (SELECT split_part(rest, '/', 1) AS name, strpos(rest, '/') > 0 AS is_dir,
                      count(*)::int AS files
                 FROM (SELECT substr(path, length($3) + 1) AS rest FROM code_files
                        WHERE doco_id = $1 AND repo = $2 AND left(path, length($3)) = $3) f
                GROUP BY 1, 2) e
        ORDER BY is_dir DESC, lower(name), name
        LIMIT ${ENTRY_LIMIT}`,
      [docoId, repo, prefix],
    )
  ).rows;
  return {
    items: rows.map((row) => ({
      id: `${repo}/${prefix}${row.name}`,
      name: row.name,
      kind: row.is_dir ? "dir" : "file",
      icon: null,
      hasChildren: row.is_dir,
      files: row.is_dir ? Number(row.files) : null,
      pending: false,
      where: "",
    })),
    more: rows.length > 0 ? Math.max(0, Number(rows[0].total) - rows.length) : 0,
  };
}

/** What is directly under one item of the code tree: the repositories at
 *  the top ("" ), a repository's or folder's entries under it, nothing
 *  under a file. */
export async function listCodeTree(
  c: QueryClient,
  docoId: string,
  under: string,
): Promise<ReaderListing> {
  if (!under) {
    const repos = await listRepos(c, docoId);
    return { items: repos, more: 0 };
  }
  const split = splitCodeId(under);
  if (!split) return { items: [], more: 0 };
  return listDir(c, docoId, split.repo, split.path);
}

/** The code tree's first listings with `id` open: the repositories, then
 *  each folder down to it. */
export function codeTreeAt(
  c: QueryClient,
  docoId: string,
  id: string,
): Promise<Record<string, ReaderListing>> {
  return listingsAlong(codeTrail(id), (under) => listCodeTree(c, docoId, under));
}

/** Files whose path names every word of `query`, for Go to file: those
 *  whose name starts with the query first, then those whose name holds
 *  it, then the rest, shorter paths first. */
export async function findCodeFiles(
  c: QueryClient,
  docoId: string,
  query: string,
  limit: number,
): Promise<ReaderTreeItem[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const rows = (
    await c.query<{ repo: string; path: string }>(
      `SELECT repo, path FROM (
         SELECT repo, path, lower(regexp_replace(path, '^.*/', '')) AS name
           FROM code_files
          WHERE doco_id = $1
            AND (SELECT bool_and(strpos(lower(path), w) > 0) FROM unnest($3::text[]) w)
       ) f
       ORDER BY CASE WHEN left(name, length($2)) = $2 THEN 0
                     WHEN strpos(name, $2) > 0 THEN 1 ELSE 2 END,
                length(path), path, repo
       LIMIT $4`,
      [docoId, q, words, limit],
    )
  ).rows;
  return rows.map((row) => {
    const slash = row.path.lastIndexOf("/");
    return {
      id: `${row.repo}/${row.path}`,
      name: row.path.slice(slash + 1),
      kind: "file",
      icon: null,
      hasChildren: false,
      files: null,
      pending: false,
      where: slash === -1 ? row.repo : `${row.repo}/${row.path.slice(0, slash)}`,
    };
  });
}

async function loadFileRow(
  c: QueryClient,
  docoId: string,
  repo: string,
  path: string,
): Promise<{ file: CodeFile; content: string } | null> {
  if (!path) return null;
  const row = (
    await c.query<{
      size: number;
      omitted: CodeFile["omitted"];
      content: string;
      synced_at: Date | string;
    }>(
      `SELECT size, omitted, content, synced_at FROM code_files
        WHERE doco_id = $1 AND repo = $2 AND path = $3`,
      [docoId, repo, path],
    )
  ).rows[0];
  if (!row) return null;
  return {
    file: {
      repo,
      path,
      url: githubFileUrl(repo, path),
      size: Number(row.size),
      omitted: row.omitted,
      syncedAt: new Date(row.synced_at).toISOString(),
    },
    content: row.content,
  };
}

async function folderView(
  c: QueryClient,
  docoId: string,
  repo: string,
  dir: string,
): Promise<CodeView | null> {
  const { items, more } = await listDir(c, docoId, repo, dir);
  if (items.length === 0) return null;
  // The folder's README reads under its entries, Markdown first.
  const readmes = items
    .filter((item) => item.kind === "file" && README_RE.test(item.name))
    .sort((a, b) => Number(MARKDOWN_RE.test(b.name)) - Number(MARKDOWN_RE.test(a.name)));
  const readmePath = readmes[0] ? splitCodeId(readmes[0].id)?.path : undefined;
  const readme = readmePath ? await loadFileRow(c, docoId, repo, readmePath) : null;
  return {
    view: "folder",
    repo,
    dir,
    entries: items,
    more,
    readme:
      readme && !readme.file.omitted ? { path: readme.file.path, markdown: readme.content } : null,
    trail: codeTrail(dir ? `${repo}/${dir}` : repo),
  };
}

/**
 * What the code reader shows at `id` (an item's address, "" for the home):
 * search results while there is a query; at the home, the repositories, or
 * the one repository's root; a folder's entries and README; or a file.
 * Null for an address the copy doesn't have.
 */
export async function loadCodeView(
  c: QueryClient,
  docoId: string,
  opts: { id: string; query: string },
): Promise<CodeView | null> {
  const query = opts.query.trim();
  if (query) {
    return { view: "search", query, hits: await searchCodebase(c, docoId, query, 50), trail: [] };
  }
  if (!opts.id) {
    const repos = await listRepos(c, docoId);
    if (repos.length === 1) return folderView(c, docoId, repos[0].id, "");
    return { view: "repos", repos, trail: [] };
  }
  const split = splitCodeId(opts.id);
  if (!split) return null;
  const found = await loadFileRow(c, docoId, split.repo, split.path);
  if (!found) return folderView(c, docoId, split.repo, split.path);
  const { file, content } = found;
  return {
    view: "file",
    file,
    lines: file.omitted ? [] : highlightLines(file.path, content),
    markdown: !file.omitted && MARKDOWN_RE.test(file.path) ? content : null,
    trail: codeTrail(`${file.repo}/${file.path}`),
  };
}
