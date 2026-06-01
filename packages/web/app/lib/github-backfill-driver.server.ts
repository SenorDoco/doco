import { backfillRepoPullRequests } from "./github-backfill.server";
// Resumable backfill driver. The setup callback can't import an org's whole PR
// history in one shot — tens of thousands of PRs blow past Vercel's function
// timeout (this is the ~5000-PR wall hit in practice). So the import is driven
// as a chain of time-budgeted SLICES: each slice walks the saved cursor
// (queue of repos × GitHub page) for up to `budgetMs`, persists progress, and
// the worker route re-triggers itself until the queue is exhausted. Every
// upsert is idempotent (keyed on the PR URL), so a crashed slice simply
// re-runs from the last persisted cursor.
import { type GitHubBackfillState, setBackfillState } from "./github-connection.server";

export interface BackfillSliceCtx {
  docoId: string;
  docoDir: string;
  ownerSlug: string;
  docoSlug: string;
  installationId: number;
}

export interface BackfillSliceDeps {
  backfillRepo: typeof backfillRepoPullRequests;
  save: (docoId: string, state: GitHubBackfillState) => Promise<void>;
  now: () => number;
}

function markerFrom(
  base: GitHubBackfillState,
  queue: string[],
  repoIndex: number,
  page: number,
  counts: { created: number; updated: number; unchanged: number; failed: number },
  done: boolean,
): GitHubBackfillState {
  return {
    status: done ? "done" : "running",
    ...(base.started_at ? { started_at: base.started_at } : {}),
    ...(done ? { finished_at: new Date().toISOString() } : {}),
    repos: queue.length,
    installation_id: base.installation_id,
    queue,
    repo_index: repoIndex,
    page,
    imported: counts.created,
    updated: counts.updated,
    unchanged: counts.unchanged,
    failed: counts.failed,
  };
}

/**
 * Process one time-budgeted slice of a Doco's PR backfill from its saved
 * cursor, persisting the advanced cursor + running tallies. Returns whether
 * the whole backfill is now complete. Pure orchestration over injectable deps
 * (testable without GitHub / DB / a real clock).
 */
export async function runBackfillSlice(
  state: GitHubBackfillState,
  ctx: BackfillSliceCtx,
  deps?: Partial<BackfillSliceDeps>,
  budgetMs = 200_000,
): Promise<{ done: boolean }> {
  const backfillRepo = deps?.backfillRepo ?? backfillRepoPullRequests;
  const save = deps?.save ?? setBackfillState;
  const now = deps?.now ?? Date.now;

  const queue = state.queue ?? [];
  let repoIndex = state.repo_index ?? 0;
  let page = state.page ?? 1;
  const counts = {
    created: state.imported ?? 0,
    updated: state.updated ?? 0,
    unchanged: state.unchanged ?? 0,
    failed: state.failed ?? 0,
  };

  const start = now();
  while (repoIndex < queue.length && now() - start < budgetMs) {
    const [owner, repo] = queue[repoIndex].split("/");
    if (!owner || !repo) {
      repoIndex++;
      page = 1;
      continue;
    }
    const r = await backfillRepo({
      docoDir: ctx.docoDir,
      docoId: ctx.docoId,
      ownerSlug: ctx.ownerSlug,
      docoSlug: ctx.docoSlug,
      owner,
      repo,
      installationId: ctx.installationId,
      startPage: page,
    });
    counts.created += r.created;
    counts.updated += r.updated;
    counts.unchanged += r.unchanged;
    counts.failed += r.failed;
    if (r.nextPage != null) page = r.nextPage;
    else {
      repoIndex++;
      page = 1;
    }
  }

  const done = repoIndex >= queue.length;
  await save(ctx.docoId, markerFrom(state, queue, repoIndex, page, counts, done));
  return { done };
}
