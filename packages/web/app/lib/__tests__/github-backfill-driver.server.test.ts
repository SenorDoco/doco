import { describe, expect, it, vi } from "vitest";

// The driver imports github-connection + github-backfill, which transitively
// import @doco/db; mock it so the module graph resolves without a real DB.
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import { runBackfillSlice } from "../github-backfill-driver.server";
import type { GitHubBackfillState } from "../github-connection.server";

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
