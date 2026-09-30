// Backfill: import a connected repo's existing items into the Doco — its pull
// requests as References, or, for a Bug tracker, its bug issues as bugs. Mints
// an installation token, pages the repo's listing (github-app), and syncs each
// item. Idempotent — safe to re-run, and safe to overlap with live webhook
// deliveries, because every sync is keyed on the item's URL.
//
// Cursor-based: each call processes one window of pages (default: 5 × 100 =
// 500 items) and returns `nextPage` when more remain. The caller should invoke
// again with `startPage = nextPage` until `nextPage` is null. This keeps each
// serverless function invocation well within Vercel's 60-second timeout even
// for repos with thousands of PRs.
import {
  type RepoPage,
  type RepoPageOpts,
  listPullRequestFiles,
  listRepoIssues,
  listRepoPullRequests,
  mintInstallationToken,
} from "./github-app.server";
import { githubImportFor } from "./github-imports";
import { type GitHubIssue, isBugIssue, syncBugIssue } from "./github-issue-import.server";
import {
  type GitHubPullRequest,
  hasBusinessProcessCodeReferences,
  upsertPullRequestReference,
} from "./github-pr-import.server";

export interface BackfillOpts {
  docoDir: string;
  docoId: string;
  ownerSlug: string;
  docoSlug: string;
  /** GitHub repo owner + name (the "owner/name" locator split). */
  owner: string;
  repo: string;
  installationId: string | number;
  createdByUserId?: string | null;
  /** GitHub page number to start from (1-based). Default: 1. */
  startPage?: number;
  /** Pages to fetch per call (100 items/page). Default: 5 (= 500 items). */
  pagesPerBatch?: number;
}

/** Injectable seams so the orchestration is unit-testable without GitHub/DB. */
export interface BackfillDeps {
  mintToken: typeof mintInstallationToken;
  listPrs: (
    token: string,
    owner: string,
    repo: string,
    opts?: RepoPageOpts,
  ) => Promise<RepoPage<GitHubPullRequest>>;
  listFiles: typeof listPullRequestFiles;
  hasCodeReferences: typeof hasBusinessProcessCodeReferences;
  upsert: typeof upsertPullRequestReference;
}

export interface BackfillResult {
  total: number;
  /** Newly captured References. */
  created: number;
  /** Existing References whose lifecycle/prose moved. */
  updated: number;
  /** Already-current References — a no-op re-sync, not a failure. */
  unchanged: number;
  /** Writes that genuinely errored. */
  failed: number;
  /**
   * When non-null, more PRs remain. Call again with `startPage = nextPage`
   * to continue the import. Null means the backfill is complete.
   */
  nextPage: number | null;
}

export async function backfillRepoPullRequests(
  opts: BackfillOpts,
  deps?: Partial<BackfillDeps>,
): Promise<BackfillResult> {
  const mintToken = deps?.mintToken ?? mintInstallationToken;
  const listPrs = deps?.listPrs ?? listRepoPullRequests;
  const listFiles = deps?.listFiles ?? listPullRequestFiles;
  const hasCodeReferences = deps?.hasCodeReferences ?? hasBusinessProcessCodeReferences;
  const upsert = deps?.upsert ?? upsertPullRequestReference;

  const startPage = opts.startPage ?? 1;
  const pagesPerBatch = opts.pagesPerBatch ?? 5;

  const { token } = await mintToken(opts.installationId);
  const { items: prs, hasMore } = await listPrs(token, opts.owner, opts.repo, {
    startPage,
    maxPages: pagesPerBatch,
  });
  const shouldLoadChangedFiles = await hasCodeReferences(opts.docoId);

  const tally = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  for (const pr of prs) {
    let changedFiles: Awaited<ReturnType<typeof listPullRequestFiles>> | undefined;
    if (shouldLoadChangedFiles) {
      try {
        changedFiles = await listFiles(token, opts.owner, opts.repo, pr.number);
      } catch (error) {
        console.warn(
          `[github backfill] unable to list files for ${opts.owner}/${opts.repo}#${pr.number}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const res = await upsert(pr, {
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      ownerSlug: opts.ownerSlug,
      docoSlug: opts.docoSlug,
      ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
      ...(changedFiles ? { changedFiles } : {}),
    });
    if (res.status === "created") tally.created++;
    else if (res.status === "updated") tally.updated++;
    else if (res.status === "unchanged") tally.unchanged++;
    else tally.failed++;
  }
  return {
    total: prs.length,
    ...tally,
    nextPage: hasMore ? startPage + pagesPerBatch : null,
  };
}

export interface BugBackfillDeps {
  mintToken: typeof mintInstallationToken;
  listIssues: (
    token: string,
    owner: string,
    repo: string,
    opts?: RepoPageOpts,
  ) => Promise<RepoPage<GitHubIssue>>;
  sync: typeof syncBugIssue;
}

/**
 * Import one window of a repo's issues into a Bug tracker: each bug issue is
 * filed as a bug (github-issue-import), every other issue and pull request is
 * passed over. Same cursor contract as `backfillRepoPullRequests`.
 */
export async function backfillRepoBugs(
  opts: BackfillOpts,
  deps?: Partial<BugBackfillDeps>,
): Promise<BackfillResult> {
  const mintToken = deps?.mintToken ?? mintInstallationToken;
  const listIssues = deps?.listIssues ?? listRepoIssues;
  const sync = deps?.sync ?? syncBugIssue;

  const startPage = opts.startPage ?? 1;
  const pagesPerBatch = opts.pagesPerBatch ?? 5;

  const { token } = await mintToken(opts.installationId);
  const { items, hasMore } = await listIssues(token, opts.owner, opts.repo, {
    startPage,
    maxPages: pagesPerBatch,
  });
  const bugs = items.filter(isBugIssue);
  const tally = { created: 0, updated: 0, unchanged: 0, failed: 0 };
  for (const issue of bugs) {
    const res = await sync(issue, {
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      ownerSlug: opts.ownerSlug,
      docoSlug: opts.docoSlug,
    });
    if (res.status === "created") tally.created++;
    else if (res.status === "updated") tally.updated++;
    else if (res.status === "unchanged") tally.unchanged++;
    else tally.failed++;
  }
  return {
    total: bugs.length,
    ...tally,
    nextPage: hasMore ? startPage + pagesPerBatch : null,
  };
}

/** Imports one window of one repo's items into a Doco. */
export type RepoBackfill = (opts: BackfillOpts) => Promise<BackfillResult>;

const REPO_BACKFILLS: Record<string, RepoBackfill> = {
  "github-pull-requests": backfillRepoPullRequests,
  bugs: backfillRepoBugs,
};

/** The repo walker for what a Doco created from `template` brings from GitHub
 *  (github-imports): bugs for a Bug tracker, pull requests for any other Doco. */
export function repoBackfillFor(template: string | null): RepoBackfill {
  return REPO_BACKFILLS[githubImportFor(template).template] ?? backfillRepoPullRequests;
}

export interface InstallationBackfillResult {
  /** Number of repos backfilled (well-formed "owner/name"). */
  repos: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}

/**
 * Backfill every repo an org installation covers — the "connect once, import
 * everything" path so no manual per-repo re-import is needed. Caller passes the
 * repo full-names (the setup callback already lists them); each is backfilled
 * with the walker for what the Doco brings (its `template`) and the per-repo
 * tallies are summed. Idempotent (keyed on each item's URL).
 */
export async function backfillInstallationRepos(
  opts: {
    docoDir: string;
    docoId: string;
    ownerSlug: string;
    docoSlug: string;
    template: string | null;
    repos: string[];
    installationId: string | number;
    createdByUserId?: string | null;
  },
  deps?: { backfillRepo?: RepoBackfill },
): Promise<InstallationBackfillResult> {
  const backfillRepo = deps?.backfillRepo ?? repoBackfillFor(opts.template);
  const tally: InstallationBackfillResult = {
    repos: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
  };
  for (const fullName of opts.repos) {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) continue;
    tally.repos++;
    const r = await backfillRepo({
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      ownerSlug: opts.ownerSlug,
      docoSlug: opts.docoSlug,
      owner,
      repo,
      installationId: opts.installationId,
      ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
    });
    tally.created += r.created;
    tally.updated += r.updated;
    tally.unchanged += r.unchanged;
    tally.failed += r.failed;
  }
  return tally;
}
