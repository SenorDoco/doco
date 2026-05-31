// Backfill: import a connected repo's existing PRs as References. Mints an
// installation token, pages the repo's PRs (github-app), and upserts each
// (github-pr-import). Idempotent — safe to re-run, and safe to overlap with
// live webhook deliveries, because the upsert is keyed on the PR URL. The
// "Import previous PRs?" button (settings, increment 5) triggers this.
import { listRepoPullRequests, mintInstallationToken } from "./github-app.server";
import { upsertPullRequestReference } from "./github-pr-import.server";

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
}

/** Injectable seams so the orchestration is unit-testable without GitHub/DB. */
export interface BackfillDeps {
  mintToken: typeof mintInstallationToken;
  listPrs: typeof listRepoPullRequests;
  upsert: typeof upsertPullRequestReference;
}

export interface BackfillResult {
  total: number;
  imported: number;
  failed: number;
}

export async function backfillRepoPullRequests(
  opts: BackfillOpts,
  deps?: Partial<BackfillDeps>,
): Promise<BackfillResult> {
  const mintToken = deps?.mintToken ?? mintInstallationToken;
  const listPrs = deps?.listPrs ?? listRepoPullRequests;
  const upsert = deps?.upsert ?? upsertPullRequestReference;

  const { token } = await mintToken(opts.installationId);
  const prs = await listPrs(token, opts.owner, opts.repo);

  let imported = 0;
  let failed = 0;
  for (const pr of prs) {
    const res = await upsert(pr, {
      docoDir: opts.docoDir,
      docoId: opts.docoId,
      ownerSlug: opts.ownerSlug,
      docoSlug: opts.docoSlug,
      ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
    });
    if ("error" in res) failed++;
    else imported++;
  }
  return { total: prs.length, imported, failed };
}
