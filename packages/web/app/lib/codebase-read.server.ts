// Reading a codebase Doco's copy of its repositories (codebase-sync): the Doco
// home's Code perspective (a repository's folders, the open file, search) and
// code results in the Doco's search. Search is full text over paths and file
// contents, matching identifiers as written. Everything here is scoped to one
// Doco; callers have already checked that the viewer can read it.

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface CodeSearchHit {
  type: "code_file";
  repo: string;
  path: string;
  url: string;
  /** The first line naming a search term, trimmed; empty when only the path matched. */
  snippet: string;
  /** That line's number, 1-based; null when only the path matched. */
  line: number | null;
}

export interface CodeEntry {
  name: string;
  /** The entry's path in its repository. */
  path: string;
  kind: "dir" | "file";
}

export interface CodeFile {
  repo: string;
  path: string;
  url: string;
  size: number;
  /** Why the copy keeps the file by name only; null when it holds the text. */
  omitted: "binary" | "too_large" | "unavailable" | null;
  content: string;
  syncedAt: string;
}

export interface CodePerspectiveData {
  /** The repositories in the copy, with their file counts. */
  repos: Array<{ repo: string; files: number }>;
  /** The open repository; null while the copy is empty. */
  repo: string | null;
  /** The open folder ("" for the repository's root). */
  dir: string;
  entries: CodeEntry[];
  /** The open file, when the path names one. */
  file: CodeFile | null;
  /** The active search, "" when browsing. */
  query: string;
  hits: CodeSearchHit[];
}

const ENTRY_LIMIT = 1000;
const SNIPPET_WIDTH = 200;

export function githubFileUrl(repo: string, path: string): string {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo}/blob/HEAD/${encoded}`;
}

/** The search terms a snippet looks for: the words of the query, lowercased. */
function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/^["-]+|"+$/g, ""))
    .filter((term) => term.length > 1);
}

/** Code files matching `query` by path or content, best first. Empty for a
 *  Doco that copies no code. */
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
    await c.query<{ repo: string; path: string; around: string; before: string | null }>(
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
       SELECT repo, path,
              -- The text around the first mention of the term, and the text
              -- before it (to count lines), when the content names it.
              CASE WHEN at > 0 THEN substr(content, at, ${SNIPPET_WIDTH}) ELSE '' END AS around,
              CASE WHEN at > 0 THEN left(content, at - 1) END AS before
         FROM (SELECT *, strpos(lower(content), $3) AS at FROM hits) h
        ORDER BY by_path DESC, rank DESC, repo, path`,
      [docoId, q, term, limit],
    )
  ).rows;
  return rows.map((row) => {
    if (row.before === null) {
      return {
        type: "code_file",
        repo: row.repo,
        path: row.path,
        url: githubFileUrl(row.repo, row.path),
        snippet: "",
        line: null,
      };
    }
    const lineStart = row.before.lastIndexOf("\n") + 1;
    const line = `${row.before.slice(lineStart)}${row.around.split("\n")[0]}`.trim();
    return {
      type: "code_file",
      repo: row.repo,
      path: row.path,
      url: githubFileUrl(row.repo, row.path),
      snippet: line.length > SNIPPET_WIDTH ? `${line.slice(0, SNIPPET_WIDTH)}…` : line,
      line: row.before.split("\n").length,
    };
  });
}

async function loadFile(
  c: QueryClient,
  docoId: string,
  repo: string,
  path: string,
): Promise<CodeFile | null> {
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
    repo,
    path,
    url: githubFileUrl(repo, path),
    size: row.size,
    omitted: row.omitted,
    content: row.content,
    syncedAt: new Date(row.synced_at).toISOString(),
  };
}

/** The folders and files directly inside `dir` ("" for the root), folders first. */
async function listDir(
  c: QueryClient,
  docoId: string,
  repo: string,
  dir: string,
): Promise<CodeEntry[]> {
  const prefix = dir ? `${dir}/` : "";
  const rows = (
    await c.query<{ name: string; is_dir: boolean }>(
      `SELECT name, is_dir
         FROM (SELECT DISTINCT split_part(rest, '/', 1) AS name, strpos(rest, '/') > 0 AS is_dir
                 FROM (SELECT substr(path, length($3) + 1) AS rest FROM code_files
                        WHERE doco_id = $1 AND repo = $2 AND left(path, length($3)) = $3) f) e
        ORDER BY is_dir DESC, lower(name), name
        LIMIT ${ENTRY_LIMIT}`,
      [docoId, repo, prefix],
    )
  ).rows;
  return rows.map((row) => ({
    name: row.name,
    path: `${prefix}${row.name}`,
    kind: row.is_dir ? "dir" : "file",
  }));
}

export async function loadCodePerspective(
  c: QueryClient,
  docoId: string,
  opts: { repo?: string | null; path?: string | null; query?: string | null; limit?: number },
): Promise<CodePerspectiveData> {
  const query = opts.query?.trim() ?? "";
  const repos = (
    await c.query<{ repo: string; files: number }>(
      `SELECT repo, count(*)::int AS files FROM code_files
        WHERE doco_id = $1 GROUP BY repo ORDER BY repo`,
      [docoId],
    )
  ).rows;
  const repo = repos.find((r) => r.repo === opts.repo)?.repo ?? repos[0]?.repo ?? null;
  const empty = { repos, repo, dir: "", entries: [], file: null, query, hits: [] };
  if (!repo) return empty;
  if (query) {
    return { ...empty, hits: await searchCodebase(c, docoId, query, opts.limit ?? 50) };
  }
  const path = (opts.path ?? "").replace(/^\/+|\/+$/g, "");
  const file = path ? await loadFile(c, docoId, repo, path) : null;
  const dir = file ? path.split("/").slice(0, -1).join("/") : path;
  const entries = await listDir(c, docoId, repo, dir);
  // A folder the copy doesn't have opens the repository's root instead.
  if (!file && dir && entries.length === 0) {
    return { ...empty, entries: await listDir(c, docoId, repo, "") };
  }
  return { ...empty, dir, entries, file };
}
