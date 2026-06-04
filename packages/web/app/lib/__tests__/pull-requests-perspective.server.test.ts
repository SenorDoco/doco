import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoConnectionsContext: vi.fn(),
}));

vi.mock("../github-connection.server", () => ({
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
}));

import {
  type PullRequestRefRow,
  loadPullRequestsPerspective,
  pullRequestItemsFromRows,
  pullRequestLabel,
} from "../pull-requests-perspective.server";

function row(over: Partial<PullRequestRefRow>): PullRequestRefRow {
  return {
    id: "reference_01TEST",
    reference: "Some title\n\nbody",
    locator: "https://github.com/acme/web/pull/1",
    lifecycle: "active",
    updated_at: "2026-06-02T16:00:00.000Z",
    ...over,
  };
}

describe("pullRequestItemsFromRows", () => {
  it("returns a flat list preserving input (newest-first) order across all lifecycles", () => {
    const items = pullRequestItemsFromRows([
      row({ id: "reference_closed", lifecycle: "retired" }),
      row({ id: "reference_open", lifecycle: "queued" }),
      row({ id: "reference_merged", lifecycle: "active" }),
    ]);

    expect(items.map((i) => i.id)).toEqual([
      "reference_closed",
      "reference_open",
      "reference_merged",
    ]);
    // No grouping/reordering — every stage stays in query order.
    expect(items.map((i) => i.lifecycle)).toEqual(["retired", "queued", "active"]);
  });

  it("uses the full reference prose as the title, not just the first line", () => {
    const items = pullRequestItemsFromRows([
      row({ reference: "Fix the thing\n\nLonger body explaining the fix." }),
    ]);

    // Perspectives render the full node name, not a first-line truncation.
    expect(items[0].title).toBe("Fix the thing\n\nLonger body explaining the fix.");
  });

  it("falls back to the locator when the prose is empty", () => {
    const items = pullRequestItemsFromRows([
      row({ reference: "   ", locator: "https://github.com/acme/web/pull/42" }),
    ]);

    expect(items[0].title).toBe("https://github.com/acme/web/pull/42");
  });

  it("normalizes an unknown/null lifecycle to queued", () => {
    const items = pullRequestItemsFromRows([row({ id: "reference_null", lifecycle: null })]);

    expect(items[0].lifecycle).toBe("queued");
  });

  it("carries the locator through as the PR url", () => {
    const items = pullRequestItemsFromRows([
      row({ id: "reference_1", locator: "https://github.com/a/b/pull/1" }),
    ]);

    expect(items[0].url).toBe("https://github.com/a/b/pull/1");
  });

  it("carries the last updated timestamp for display", () => {
    const items = pullRequestItemsFromRows([
      row({ id: "reference_1", updated_at: "2026-06-02T17:00:00.000Z" }),
    ]);

    expect(items[0].updatedAt).toBe("2026-06-02T17:00:00.000Z");
  });
});

describe("pullRequestLabel", () => {
  it("maps lifecycle stages to Merged / Open / Closed (unknown → Open)", () => {
    expect(pullRequestLabel("active")).toBe("Merged");
    expect(pullRequestLabel("queued")).toBe("Open");
    expect(pullRequestLabel("retired")).toBe("Closed");
    expect(pullRequestLabel("whatever")).toBe("Open");
  });
});

describe("loadPullRequestsPerspective", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDocoConnectionsContext.mockResolvedValue({
      connections: [{ repo: "acme/web", installation_id: 42 }],
    });
  });

  function makeClient(rows: Record<string, unknown>[]) {
    const captured: { sql: string; params?: unknown[] }[] = [];
    const client = {
      async query<T>(sql: string, params?: unknown[]) {
        captured.push({ sql, params });
        return { rows: rows as T[] };
      },
    };
    return { client, captured };
  }

  function prRow(over: Record<string, unknown>) {
    return {
      id: "reference_1",
      reference: "Merged PR",
      locator: "https://github.com/acme/web/pull/1",
      lifecycle: "active",
      total_count: "2",
      ...over,
    };
  }

  it("caps the rows shown but reports the true total via a scalar COUNT subquery", async () => {
    // The query returns the latest `limit + 1` rows, each carrying the true
    // total from an uncorrelated scalar subquery (a bigint, which pg hands back
    // as a string). With limit 1 only one row is shown, but totalCount reflects
    // the full 1,203-row domain.
    const { client, captured } = makeClient([
      prRow({ id: "reference_1", total_count: "1203" }),
      prRow({
        id: "reference_2",
        locator: "https://github.com/acme/web/pull/2",
        total_count: "1203",
      }),
    ]);

    const data = await loadPullRequestsPerspective(client, "doco_1", { limit: 1 });

    expect(captured[0].sql).toMatch(/LIMIT \$2/);
    // True total comes from a scalar subquery, not a window function.
    expect(captured[0].sql).toMatch(/\(SELECT COUNT\(\*\)/);
    expect(captured[0].sql).not.toMatch(/COUNT\(\*\) OVER/);
    expect(captured[0].params).toEqual(["doco_1", 2]);
    expect(data.loadedCount).toBe(1);
    expect(data.totalCount).toBe(1203);
    expect(data.hasMore).toBe(true);
    expect(data.items).toHaveLength(1);
  });

  it("returns a flat newest-first list without grouping by lifecycle", async () => {
    const { client } = makeClient([
      prRow({ id: "reference_merged", lifecycle: "active", total_count: "3" }),
      prRow({ id: "reference_open", lifecycle: "queued", total_count: "3" }),
      prRow({ id: "reference_closed", lifecycle: "retired", total_count: "3" }),
    ]);

    const data = await loadPullRequestsPerspective(client, "doco_1", { limit: 10 });

    expect(data.items.map((i) => i.id)).toEqual([
      "reference_merged",
      "reference_open",
      "reference_closed",
    ]);
    expect(data.loadedCount).toBe(3);
    expect(data.totalCount).toBe(3);
    expect(data.hasMore).toBe(false);
  });

  it("returns an empty list and zero total when the Doco has no PRs", async () => {
    const { client } = makeClient([]);

    const data = await loadPullRequestsPerspective(client, "doco_1", { limit: 5 });

    expect(data.items).toEqual([]);
    expect(data.totalCount).toBe(0);
    expect(data.hasMore).toBe(false);
  });

  it("loads PRs by most recently updated and exposes the updated timestamp", async () => {
    const { client, captured } = makeClient([
      prRow({
        id: "reference_recent",
        reference: "Recently updated",
        locator: "https://github.com/acme/web/pull/2",
        total_count: "1",
        updated_at: "2026-06-02T17:00:00.000Z",
      }),
    ]);

    const data = await loadPullRequestsPerspective(client, "doco_1");

    expect(captured[0].sql).toMatch(/updated_at::text AS updated_at/);
    expect(captured[0].sql).toMatch(/ORDER BY updated_at DESC, created_at DESC, id ASC/);
    expect(data.items[0].updatedAt).toBe("2026-06-02T17:00:00.000Z");
  });

  describe("lifecycle filter", () => {
    it("applies no lifecycle predicate when no stages are given (all)", async () => {
      const { client, captured } = makeClient([prRow({ total_count: "5" })]);
      await loadPullRequestsPerspective(client, "doco_1", { limit: 10 });
      expect(captured[0].sql).not.toMatch(/lifecycle = '/);
      expect(captured[0].sql).not.toMatch(/lifecycle NOT IN/);
    });

    it("applies no predicate when all canonical stages are selected", async () => {
      const { client, captured } = makeClient([prRow({ total_count: "5" })]);
      await loadPullRequestsPerspective(client, "doco_1", {
        limit: 10,
        lifecycles: ["queued", "active", "retired"],
      });
      expect(captured[0].sql).not.toMatch(/lifecycle = '|lifecycle NOT IN/);
    });

    it("filters to Merged only (active) in BOTH the slice and the count subquery", async () => {
      const { client, captured } = makeClient([prRow({ lifecycle: "active", total_count: "2" })]);
      await loadPullRequestsPerspective(client, "doco_1", { limit: 10, lifecycles: ["active"] });
      // The clause appears twice: once in the COUNT subquery, once in the main WHERE.
      const matches = captured[0].sql.match(/lifecycle = 'active'/g) ?? [];
      expect(matches).toHaveLength(2);
      // Stages are whitelisted literals, so no extra bound parameter is needed.
      expect(captured[0].params).toEqual(["doco_1", 11]);
    });

    it("treats Open (queued) as the catch-all: anything not Merged/Closed", async () => {
      const { client, captured } = makeClient([prRow({ lifecycle: "queued", total_count: "1" })]);
      await loadPullRequestsPerspective(client, "doco_1", { limit: 10, lifecycles: ["queued"] });
      expect(captured[0].sql).toMatch(/lifecycle NOT IN \('active', 'retired'\)/);
    });

    it("returns an empty result WITHOUT querying when no stages are selected (none)", async () => {
      const { client, captured } = makeClient([prRow({})]);
      const data = await loadPullRequestsPerspective(client, "doco_1", {
        limit: 10,
        lifecycles: [],
      });
      expect(captured).toHaveLength(0);
      expect(data.items).toEqual([]);
      expect(data.totalCount).toBe(0);
      expect(data.loadedCount).toBe(0);
      expect(data.hasMore).toBe(false);
    });
  });
});
