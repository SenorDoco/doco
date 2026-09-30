// Codebase copy: a codebase Doco keeps every file on the default branch of the
// repositories it brings from GitHub (github-imports) in `code_files`. One
// walk serves the first import, a re-import and every push: list the branch's
// tree, fetch the files whose blob sha changed (new ones included), and, once
// nothing is left to fetch, drop the files the branch no longer has. Walking
// again is cheap and idempotent: unchanged files cost no GitHub call.
//
// Cursor contract as the other repo walkers (github-backfill): each call
// fetches up to `pagesPerBatch` × 100 changed files and returns `nextPage`
// while more remain. The page number only counts calls: what is left to
// fetch is whatever still differs from the tree.
import { withClient } from "@doco/db";
import {
  type RepoFile,
  getBlobTexts,
  getRepoTree,
  mintInstallationToken,
} from "./github-app.server";
import type { BackfillOpts, BackfillResult } from "./github-backfill.server";

/** Larger files are kept by name only: code that size is generated or data. */
export const MAX_FILE_BYTES = 200_000;
const FILES_PER_PAGE = 100;
/** Blobs per GraphQL request: bounded so one response stays a few MB. */
const BLOBS_PER_REQUEST = 25;

export interface CodebaseDeps {
  mintToken: typeof mintInstallationToken;
  getTree: typeof getRepoTree;
  getTexts: typeof getBlobTexts;
}

type Omitted = "binary" | "too_large" | "unavailable";

async function storedShas(docoId: string, repo: string): Promise<Map<string, string>> {
  return withClient(async (c) => {
    const r = await c.query<{ path: string; sha: string }>(
      "SELECT path, sha FROM code_files WHERE doco_id = $1 AND repo = $2",
      [docoId, repo],
    );
    return new Map(r.rows.map((row) => [row.path, row.sha]));
  });
}

async function writeFiles(
  docoId: string,
  repo: string,
  rows: Array<RepoFile & { content: string; omitted: Omitted | null }>,
): Promise<void> {
  if (rows.length === 0) return;
  await withClient(async (c) => {
    // A repository disconnected mid-walk gets nothing more (see
    // code_repo_connected in schema.sql).
    await c.query(
      `INSERT INTO code_files (doco_id, repo, path, sha, size, content, omitted, synced_at)
       SELECT $1, $2, t.path, t.sha, t.size, t.content, t.omitted, now()
         FROM unnest($3::text[], $4::text[], $5::int[], $6::text[], $7::text[])
              AS t(path, sha, size, content, omitted)
        WHERE code_repo_connected(
                (SELECT data->'github_integration' FROM docos WHERE id = $1), $2)
       ON CONFLICT (doco_id, repo, path) DO UPDATE
          SET sha = EXCLUDED.sha, size = EXCLUDED.size, content = EXCLUDED.content,
              omitted = EXCLUDED.omitted, synced_at = EXCLUDED.synced_at`,
      [
        docoId,
        repo,
        rows.map((r) => r.path),
        rows.map((r) => r.sha),
        rows.map((r) => r.size),
        rows.map((r) => r.content),
        rows.map((r) => r.omitted),
      ],
    );
  });
}

async function dropFilesNotIn(docoId: string, repo: string, paths: string[]): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM code_files
        WHERE doco_id = $1 AND repo = $2 AND NOT (path = ANY($3::text[]))`,
      [docoId, repo, paths],
    );
  });
}

/** Bring one window of a repository's changed files into a codebase Doco. */
export async function backfillRepoCodebase(
  opts: BackfillOpts,
  deps?: Partial<CodebaseDeps>,
): Promise<BackfillResult> {
  const mintToken = deps?.mintToken ?? mintInstallationToken;
  const getTree = deps?.getTree ?? getRepoTree;
  const getTexts = deps?.getTexts ?? getBlobTexts;
  const startPage = opts.startPage ?? 1;
  const window = (opts.pagesPerBatch ?? 5) * FILES_PER_PAGE;
  const repo = `${opts.owner}/${opts.repo}`;

  const { token } = await mintToken(opts.installationId);
  const tree = await getTree(token, opts.owner, opts.repo);
  if (tree.truncated) {
    console.warn(`[codebase] ${repo}: GitHub truncated the tree; copying the files it listed`);
  }
  const stored = await storedShas(opts.docoId, repo);
  const changed = tree.files
    .filter((f) => stored.get(f.path) !== f.sha)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const batch = changed.slice(0, window);

  const fetchable = batch.filter((f) => f.size <= MAX_FILE_BYTES);
  const texts = new Map<string, string | null>();
  for (let i = 0; i < fetchable.length; i += BLOBS_PER_REQUEST) {
    const shas = [...new Set(fetchable.slice(i, i + BLOBS_PER_REQUEST).map((f) => f.sha))];
    for (const [sha, text] of await getTexts(token, opts.owner, opts.repo, shas)) {
      texts.set(sha, text);
    }
  }
  await writeFiles(
    opts.docoId,
    repo,
    batch.map((f) => {
      if (f.size > MAX_FILE_BYTES) return { ...f, content: "", omitted: "too_large" };
      if (!texts.has(f.sha)) return { ...f, content: "", omitted: "unavailable" };
      const text = texts.get(f.sha);
      // Postgres text can't hold NUL; a text file with one keeps the rest.
      return text == null
        ? { ...f, content: "", omitted: "binary" }
        : { ...f, content: text.replaceAll("\u0000", ""), omitted: null };
    }),
  );

  const hasMore = changed.length > batch.length;
  if (!hasMore) {
    await dropFilesNotIn(
      opts.docoId,
      repo,
      tree.files.map((f) => f.path),
    );
  }
  const updated = batch.filter((f) => stored.has(f.path)).length;
  return {
    total: batch.length,
    created: batch.length - updated,
    updated,
    // Files already current when the walk began; later windows would count
    // the ones earlier windows fetched.
    unchanged: startPage === 1 ? tree.files.length - changed.length : 0,
    failed: 0,
    nextPage: hasMore ? startPage + (opts.pagesPerBatch ?? 5) : null,
  };
}

/**
 * Bring a push into a codebase Doco: walk window after window until the copy
 * matches the branch or `budgetMs` is spent. The walk is diff-driven, so
 * whatever a huge push leaves undone is caught up by the next one.
 */
export async function syncRepoCodebase(
  opts: BackfillOpts,
  deps?: Partial<CodebaseDeps>,
  budgetMs = 200_000,
): Promise<{ done: boolean }> {
  const start = Date.now();
  let page: number | null = 1;
  do {
    page = (await backfillRepoCodebase({ ...opts, startPage: page }, deps)).nextPage;
  } while (page !== null && Date.now() - start < budgetMs);
  if (page !== null) {
    console.warn(`[codebase] ${opts.owner}/${opts.repo}: push too large to copy at once`);
  }
  return { done: page === null };
}
