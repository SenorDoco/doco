import { describe, expect, it, vi } from "vitest";

// The driver imports github-connection + github-backfill, which transitively
// import @doco/db; mock it so the module graph resolves without a real DB.
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import { GitHubApiError } from "../github-app.server";
import { runBackfillSlice } from "../github-backfill-driver.server";
import type { GitHubBackfillState } from "../github-connection.server";

const rateLimitError = (retryAfterMs: number) =>
  new GitHubApiError({
    message: "rate limited",
    status: 429,
    rateLimited: true,
    permanent: false,
    retryAfterMs,
  });
const permanentError = () =>
  new GitHubApiError({
    message: "GitHub GET … failed: 404",
    status: 404,
    rateLimited: false,
    permanent: true,
    retryAfterMs: null,
  });

const ctx = {
  docoId: "doco_1",
  docoDir: "/tmp/d",
  ownerSlug: "o",
  docoSlug: "d",
  installationId: 42,
};

// backfillRepo result helper.
const page = (
  over: Partial<{
    created: number;
    updated: number;
    unchanged: number;
    failed: number;
    nextPage: number | null;
  }> = {},
) => ({
  total: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  failed: 0,
  nextPage: null,
  ...over,
});

const lastSaved = (save: ReturnType<typeof vi.fn>): GitHubBackfillState =>
  save.mock.calls.at(-1)?.[1] as GitHubBackfillState;

const baseState = (over: Partial<GitHubBackfillState> = {}): GitHubBackfillState => ({
  status: "running",
  started_at: "2026-01-01T00:00:00.000Z",
  installation_id: 42,
  queue: ["acme/a", "acme/b"],
  repo_index: 0,
  page: 1,
  ...over,
});

describe("runBackfillSlice", () => {
  it("walks the whole queue and marks done when it fits the budget", async () => {
    const backfillRepo = vi
      .fn()
      .mockResolvedValueOnce(page({ created: 2 })) // acme/a, page 1, no more
      .mockResolvedValueOnce(page({ created: 3, updated: 1 })); // acme/b, page 1, no more
    const save = vi.fn(async () => {});

    const res = await runBackfillSlice(
      baseState(),
      ctx,
      { backfillRepo: backfillRepo as never, save, now: () => 0 },
      200_000,
    );

    expect(res.done).toBe(true);
    expect(backfillRepo).toHaveBeenCalledTimes(2);
    expect(backfillRepo).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ owner: "acme", repo: "a", startPage: 1, installationId: 42 }),
    );
    expect(backfillRepo).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ owner: "acme", repo: "b", startPage: 1 }),
    );
    // Final marker: done, full tallies, repo_index past the end.
    const saved = lastSaved(save);
    expect(saved.status).toBe("done");
    expect(saved.finished_at).toBeTruthy();
    expect(saved.imported).toBe(5);
    expect(saved.updated).toBe(1);
    expect(saved.repo_index).toBe(2);
  });

  it("advances the page cursor within a repo when nextPage is returned", async () => {
    const backfillRepo = vi
      .fn()
      .mockResolvedValueOnce(page({ created: 5, nextPage: 6 })) // acme/a still has more
      .mockResolvedValueOnce(page({ created: 5, nextPage: null })) // acme/a done
      .mockResolvedValueOnce(page({ created: 1, nextPage: null })); // acme/b done
    const save = vi.fn(async () => {});

    const res = await runBackfillSlice(
      baseState(),
      ctx,
      { backfillRepo: backfillRepo as never, save, now: () => 0 },
      200_000,
    );

    expect(res.done).toBe(true);
    expect(backfillRepo).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ repo: "a", startPage: 1 }),
    );
    expect(backfillRepo).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ repo: "a", startPage: 6 }),
    );
    expect(backfillRepo).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ repo: "b", startPage: 1 }),
    );
  });

  it("stops at the time budget and persists a resumable cursor (not done)", async () => {
    // queue of 3 repos, each finishes in one page; clock jumps past the budget
    // after the first call so only one repo is processed this slice.
    const backfillRepo = vi.fn().mockResolvedValue(page({ created: 1 }));
    const save = vi.fn(async () => {});
    // now() sequence: start=0, first loop-check=10 (<100, enter), second=200 (stop)
    const ticks = [0, 10, 200];
    let i = 0;
    const now = () => ticks[Math.min(i++, ticks.length - 1)];

    const res = await runBackfillSlice(
      baseState({ queue: ["acme/a", "acme/b", "acme/c"] }),
      ctx,
      { backfillRepo: backfillRepo as never, save, now },
      100,
    );

    expect(res.done).toBe(false);
    expect(backfillRepo).toHaveBeenCalledTimes(1);
    const saved = lastSaved(save);
    expect(saved.status).toBe("running");
    expect(saved.finished_at).toBeUndefined();
    expect(saved.repo_index).toBe(1); // advanced past the completed repo
    expect(saved.page).toBe(1);
    expect(saved.imported).toBe(1);
  });

  it("persists the cursor after every window, not just at slice end (durability)", async () => {
    // One repo spanning three windows. The OLD driver saved the cursor only
    // AFTER the whole budget loop, so a hard function timeout — Vercel kills the
    // slice before that final save, because the slice budget (200s) exceeds the
    // function's maxDuration — stranded the cursor at the start. Every re-kick
    // then re-walked from page 1 and the import plateaued (the real-world stall
    // at ~half of a 46k-PR org). The cursor must be persisted after each window
    // so an interrupted slice still advances.
    const backfillRepo = vi
      .fn()
      .mockResolvedValueOnce(page({ created: 5, nextPage: 6 }))
      .mockResolvedValueOnce(page({ created: 5, nextPage: 11 }))
      .mockResolvedValueOnce(page({ created: 5, nextPage: null }));
    const save = vi.fn(async () => {});

    const res = await runBackfillSlice(
      baseState({ queue: ["acme/a"] }),
      ctx,
      { backfillRepo: backfillRepo as never, save, now: () => 0 },
      200_000,
    );

    expect(res.done).toBe(true);
    // A durable save per processed window (≥3), not one end-of-slice save.
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(3);
    // Intermediate cursors were persisted WHILE still running, so a next slice
    // interrupted by a timeout resumes mid-repo instead of from page 1.
    const runningPages = (save.mock.calls as unknown as [string, GitHubBackfillState][])
      .map(([, state]) => state)
      .filter((s) => s.status === "running")
      .map((s) => s.page);
    expect(runningPages).toContain(6);
    expect(runningPages).toContain(11);
    expect(lastSaved(save).status).toBe("done");
    expect(lastSaved(save).imported).toBe(15);
  });

  it("resumes from a mid-queue saved cursor", async () => {
    const backfillRepo = vi.fn().mockResolvedValue(page({ created: 1 }));
    const save = vi.fn(async () => {});

    await runBackfillSlice(
      baseState({ queue: ["acme/a", "acme/b"], repo_index: 1, page: 4, imported: 99 }),
      ctx,
      { backfillRepo: backfillRepo as never, save, now: () => 0 },
      200_000,
    );

    // Picks up at repo index 1, page 4 — never re-touches acme/a.
    expect(backfillRepo).toHaveBeenCalledTimes(1);
    expect(backfillRepo).toHaveBeenCalledWith(expect.objectContaining({ repo: "b", startPage: 4 }));
    const saved = lastSaved(save);
    expect(saved.imported).toBe(100); // 99 carried forward + 1
  });

  it("skips malformed repo full-names without calling backfillRepo", async () => {
    const backfillRepo = vi.fn().mockResolvedValue(page({ created: 1 }));
    const save = vi.fn(async () => {});

    const res = await runBackfillSlice(
      baseState({ queue: ["bogus", "acme/b"] }),
      ctx,
      { backfillRepo: backfillRepo as never, save, now: () => 0 },
      200_000,
    );

    expect(res.done).toBe(true);
    expect(backfillRepo).toHaveBeenCalledTimes(1);
    expect(backfillRepo).toHaveBeenCalledWith(expect.objectContaining({ repo: "b" }));
  });

  it("marks done immediately for an empty queue", async () => {
    const backfillRepo = vi.fn();
    const save = vi.fn(async () => {});

    const res = await runBackfillSlice(
      baseState({ queue: [] }),
      ctx,
      { backfillRepo: backfillRepo as never, save, now: () => 0 },
      200_000,
    );

    expect(res.done).toBe(true);
    expect(backfillRepo).not.toHaveBeenCalled();
    expect(lastSaved(save).status).toBe("done");
  });
});

// The wedge bug: one repo throwing (rate limit, a gone/forbidden repo, a
// transient 5xx) used to propagate out of runBackfillSlice BEFORE the cursor
// was saved, so the chain died, the count froze, and the 5-minute sweep just
// re-threw the same error forever. The slice must instead isolate the failure,
// always persist the cursor, and keep the import moving.
describe("runBackfillSlice — resilience to a throwing repo", () => {
  it("never aborts the slice without saving when a repo throws (the core regression)", async () => {
    const backfillRepo = vi.fn().mockRejectedValue(new Error("boom: transient 503"));
    const save = vi.fn(async () => {});

    // Old behaviour: this rejected and `save` was never called. New: it resolves.
    await expect(
      runBackfillSlice(
        baseState({ queue: ["acme/a", "acme/b"] }),
        ctx,
        { backfillRepo: backfillRepo as never, save, now: () => 0 },
        200_000,
      ),
    ).resolves.toMatchObject({ done: false });
    expect(save).toHaveBeenCalledTimes(1);
    const saved = lastSaved(save);
    expect(saved.status).toBe("running");
    expect(saved.repo_index).toBe(0); // cursor held on the failing repo
    expect(saved.attempts).toBe(1); // one strike recorded for a bounded retry
  });

  it("skips a permanently-gone repo (404) immediately and finishes the rest", async () => {
    const backfillRepo = vi
      .fn()
      .mockRejectedValueOnce(permanentError()) // acme/a — gone
      .mockResolvedValueOnce(page({ created: 4 })); // acme/b — fine
    const save = vi.fn(async () => {});

    const res = await runBackfillSlice(
      baseState({ queue: ["acme/a", "acme/b"] }),
      ctx,
      { backfillRepo: backfillRepo as never, save, now: () => 0 },
      200_000,
    );

    expect(res.done).toBe(true);
    expect(backfillRepo).toHaveBeenCalledTimes(2);
    const saved = lastSaved(save);
    expect(saved.status).toBe("done");
    expect(saved.imported).toBe(4); // acme/b still imported
    expect(saved.errors).toEqual([
      expect.objectContaining({ repo: "acme/a", message: expect.stringContaining("404") }),
    ]);
  });

  it("retries a transient failure across slices, then skips it after the cap", async () => {
    // acme/a always throws a transient error; acme/b is healthy.
    const backfillRepo = vi.fn(async (o: { repo: string }) => {
      if (o.repo === "a") throw new Error("transient 502");
      return page({ created: 1 });
    });
    const save = vi.fn(async () => {});

    let state: GitHubBackfillState = baseState({ queue: ["acme/a", "acme/b"] });
    let done = false;
    let slices = 0;
    while (!done && slices < 10) {
      const res = await runBackfillSlice(
        state,
        ctx,
        { backfillRepo: backfillRepo as never, save, now: () => 0 },
        200_000,
      );
      done = res.done;
      state = lastSaved(save);
      slices++;
    }

    expect(done).toBe(true);
    // acme/a attempted exactly the cap (3) before being skipped; acme/b once.
    expect(backfillRepo.mock.calls.filter((c) => c[0].repo === "a")).toHaveLength(3);
    expect(backfillRepo.mock.calls.filter((c) => c[0].repo === "b")).toHaveLength(1);
    expect(state.imported).toBe(1);
    expect(state.errors).toEqual([expect.objectContaining({ repo: "acme/a" })]);
  });

  it("pauses (does not skip) on a rate limit, recording retry_after and holding the cursor", async () => {
    const backfillRepo = vi.fn().mockRejectedValue(rateLimitError(60_000));
    const save = vi.fn(async () => {});

    const res = await runBackfillSlice(
      baseState({ queue: ["acme/a", "acme/b"] }),
      ctx,
      { backfillRepo: backfillRepo as never, save, now: () => 0 },
      200_000,
    );

    expect(res).toMatchObject({ done: false, rateLimited: true });
    expect(backfillRepo).toHaveBeenCalledTimes(1); // stopped the whole slice
    const saved = lastSaved(save);
    expect(saved.repo_index).toBe(0); // not advanced — we'll resume here
    expect(saved.attempts ?? 0).toBe(0); // a pause is not a failed attempt
    expect(saved.errors ?? []).toEqual([]); // nothing skipped
    expect(saved.retry_after).toBe(new Date(60_000).toISOString());
  });
});
