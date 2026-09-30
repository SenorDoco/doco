// Resumable backfill driver. The setup callback can't import an org's whole
// history (its pull requests, or its bug issues for a GitHub bugs Doco) in one shot — tens of thousands of PRs blow past Vercel's function
// timeout (this is the ~5000-PR wall hit in practice). So the import is driven
// as a chain of time-budgeted SLICES: each slice walks the saved cursor
// (queue of repos × GitHub page) for up to `budgetMs`, persists progress, and
// the worker route re-triggers itself until the queue is exhausted. Every
// upsert is idempotent (keyed on the item URL), so a crashed slice simply
// re-runs from the last persisted cursor.
//
// Resilience: a single repo failing (a rate limit, a gone/forbidden repo, a
// transient 5xx) must NOT take the whole import down. The slice isolates each
// repo's failure, ALWAYS persists the cursor, and keeps moving:
//   • rate limit  → pause the slice, stamp `retry_after`, resume after it clears
//   • permanent   → record the repo in `errors[]` and skip it
//   • transient   → retry the same cursor a few times, then record + skip
// Before this, an unhandled throw skipped the cursor save entirely, so the
// chain died, the count froze, and the sweep just re-threw forever.
import { classifyGitHubError } from "./github-app.server";
import { type RepoBackfill, repoBackfillFor } from "./github-backfill.server";
import {
  type BackfillError,
  type GitHubBackfillState,
  setBackfillState,
} from "./github-connection.server";

/** Times a single failing cursor position is retried (across slices) before the
 *  repo is recorded and skipped, so one bad repo can't wedge the whole import. */
const MAX_REPO_ATTEMPTS = 3;
/** Fallback pause when a rate-limit response carries no timing hint. */
const DEFAULT_RATE_LIMIT_MS = 60_000;
/** Cap a rate-limit pause so a bogus `x-ratelimit-reset` can't park it for days. */
const MAX_RATE_LIMIT_MS = 60 * 60_000;
/** Bound the recorded-errors list on a huge org. */
const MAX_RECORDED_ERRORS = 50;

export interface BackfillSliceCtx {
  docoId: string;
  docoDir: string;
  ownerSlug: string;
  docoSlug: string;
  /** The Doco's template: what it brings from GitHub (github-imports). */
  template: string | null;
  /** The GitHub installation each connected repository imports through. A
   *  queued repository missing here was disconnected, so it is skipped. */
  installationByRepo: Record<string, number>;
}

export interface BackfillSliceDeps {
  backfillRepo: RepoBackfill;
  save: (docoId: string, state: GitHubBackfillState) => Promise<void>;
  now: () => number;
  classifyError: typeof classifyGitHubError;
}

function markerFrom(
  base: GitHubBackfillState,
  queue: string[],
  repoIndex: number,
  page: number,
  counts: { created: number; updated: number; unchanged: number; failed: number },
  done: boolean,
  extra: { attempts: number; errors: BackfillError[]; retryAfter?: string },
): GitHubBackfillState {
  return {
    status: done ? "done" : "running",
    ...(base.started_at ? { started_at: base.started_at } : {}),
    ...(done ? { finished_at: new Date().toISOString() } : {}),
    repos: queue.length,
    queue,
    repo_index: repoIndex,
    page,
    imported: counts.created,
    updated: counts.updated,
    unchanged: counts.unchanged,
    failed: counts.failed,
    // The retry cursor (attempt count + rate-limit pause) is transient: carry it
    // only while still running. A finished import clears it but keeps `errors[]`
    // so the UI can show which repos were skipped.
    ...(!done && extra.attempts > 0 ? { attempts: extra.attempts } : {}),
    ...(!done && extra.retryAfter ? { retry_after: extra.retryAfter } : {}),
    ...(extra.errors.length > 0 ? { errors: extra.errors } : {}),
    // Heartbeat: every persisted slice advances this, so the sweep can tell a
    // live chain (fresh) from a stranded one (stale) and re-kick only the latter.
    cursor_at: new Date().toISOString(),
  };
}

/**
 * Process one time-budgeted slice of a Doco's backfill from its saved
 * cursor, persisting the advanced cursor + running tallies. Returns whether the
 * whole backfill is complete and whether it paused on a rate limit (so the
 * worker can hold off re-kicking until the window clears). Pure orchestration
 * over injectable deps (testable without GitHub / DB / a real clock).
 */
export async function runBackfillSlice(
  state: GitHubBackfillState,
  ctx: BackfillSliceCtx,
  deps?: Partial<BackfillSliceDeps>,
  budgetMs = 200_000,
): Promise<{ done: boolean; rateLimited: boolean }> {
  const backfillRepo = deps?.backfillRepo ?? repoBackfillFor(ctx.template);
  const save = deps?.save ?? setBackfillState;
  const now = deps?.now ?? Date.now;
  const classify = deps?.classifyError ?? classifyGitHubError;

  const queue = state.queue ?? [];
  let repoIndex = state.repo_index ?? 0;
  let page = state.page ?? 1;
  let attempts = state.attempts ?? 0;
  const errors: BackfillError[] = [...(state.errors ?? [])];
  const counts = {
    created: state.imported ?? 0,
    updated: state.updated ?? 0,
    unchanged: state.unchanged ?? 0,
    failed: state.failed ?? 0,
  };
  let retryAfter: string | undefined;
  let rateLimited = false;

  const persist = (done: boolean) =>
    save(
      ctx.docoId,
      markerFrom(state, queue, repoIndex, page, counts, done, { attempts, errors, retryAfter }),
    );

  const start = now();
  while (repoIndex < queue.length && now() - start < budgetMs) {
    const [owner, repo] = queue[repoIndex].split("/");
    const installationId = ctx.installationByRepo[queue[repoIndex]];
    if (!owner || !repo || !installationId) {
      repoIndex++;
      page = 1;
      attempts = 0;
      continue;
    }
    try {
      const r = await backfillRepo({
        docoDir: ctx.docoDir,
        docoId: ctx.docoId,
        ownerSlug: ctx.ownerSlug,
        docoSlug: ctx.docoSlug,
        owner,
        repo,
        installationId,
        startPage: page,
      });
      counts.created += r.created;
      counts.updated += r.updated;
      counts.unchanged += r.unchanged;
      counts.failed += r.failed;
      attempts = 0;
      if (r.nextPage != null) page = r.nextPage;
      else {
        repoIndex++;
        page = 1;
      }
      // Persist the advanced cursor after EVERY window — not only at the end of
      // the slice. The slice's time budget (`budgetMs`) can exceed the Vercel
      // function's `maxDuration`, which hard-kills the invocation mid-loop,
      // BEFORE the post-loop save. Without a per-window checkpoint the cursor
      // never advanced, so each re-kick re-walked from the start and the import
      // plateaued. Checkpointing here makes forward progress durable: the next
      // slice (chained or swept) resumes from the last completed window.
      await persist(repoIndex >= queue.length);
    } catch (err) {
      const c = classify(err);
      if (c.rateLimited) {
        // A rate limit is a pause, not a failure: stop the whole slice (every
        // repo shares GitHub's budget), hold the cursor here, and resume after
        // the window. Don't burn a retry attempt on it.
        const waitMs = Math.min(c.retryAfterMs ?? DEFAULT_RATE_LIMIT_MS, MAX_RATE_LIMIT_MS);
        retryAfter = new Date(now() + Math.max(0, waitMs)).toISOString();
        rateLimited = true;
        break;
      }
      attempts++;
      if (c.permanent || attempts >= MAX_REPO_ATTEMPTS) {
        // Give up on this repo so the rest of the import can finish.
        if (errors.length < MAX_RECORDED_ERRORS) {
          errors.push({
            repo: `${owner}/${repo}`,
            page,
            message: err instanceof Error ? err.message : String(err),
            at: new Date(now()).toISOString(),
          });
        }
        repoIndex++;
        page = 1;
        attempts = 0;
      } else {
        // Transient: persist the strike and retry this same position next slice.
        break;
      }
    }
  }

  const done = repoIndex >= queue.length;
  await persist(done);
  return { done, rateLimited };
}
