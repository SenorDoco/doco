import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoConnectionsContext: vi.fn(),
}));

vi.mock("../github-connection.server", () => ({
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
}));

import {
  type PullRequestRefRow,
  groupPullRequestReferences,
  loadPullRequestsPerspective,
} from "../pull-requests-perspective.server";

function row(over: Partial<PullRequestRefRow>): PullRequestRefRow {
  return {
    id: "reference_01TEST",
    reference: "Some title\n\nbody",
    locator: "https://github.com/acme/web/pull/1",
    lifecycle: "asserted",
    ...over,
  };
}

describe("groupPullRequestReferences", () => {
  it("buckets PRs into Merged/Open/Closed by lifecycle in that order", () => {
    const groups = groupPullRequestReferences([
      row({ id: "reference_open", lifecycle: "drafting" }),
      row({ id: "reference_merged", lifecycle: "asserted" }),
      row({ id: "reference_closed", lifecycle: "retired" }),
    ]);

    expect(groups.map((g) => g.lifecycle)).toEqual(["asserted", "drafting", "retired"]);
    expect(groups.map((g) => g.label)).toEqual(["Merged", "Open", "Closed"]);
    expect(groups.map((g) => g.prs.map((p) => p.id))).toEqual([
      ["reference_merged"],
      ["reference_open"],
      ["reference_closed"],
    ]);
  });

  it("omits a lifecycle group when it has no PRs", () => {
    const groups = groupPullRequestReferences([
      row({ id: "reference_a", lifecycle: "asserted" }),
      row({ id: "reference_b", lifecycle: "asserted" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].lifecycle).toBe("asserted");
    expect(groups[0].prs).toHaveLength(2);
  });

  it("derives the PR title from the first line of the reference prose", () => {
    const groups = groupPullRequestReferences([
      row({ reference: "Fix the thing\n\nLonger body explaining the fix." }),
    ]);

    expect(groups[0].prs[0].title).toBe("Fix the thing");
  });

  it("falls back to the locator when the prose is empty", () => {
    const groups = groupPullRequestReferences([
      row({ reference: "   ", locator: "https://github.com/acme/web/pull/42" }),
    ]);

    expect(groups[0].prs[0].title).toBe("https://github.com/acme/web/pull/42");
  });

  it("treats a null/unknown lifecycle as drafting (open)", () => {
    const groups = groupPullRequestReferences([row({ id: "reference_null", lifecycle: null })]);

    expect(groups).toHaveLength(1);
    expect(groups[0].lifecycle).toBe("drafting");
    expect(groups[0].prs[0].id).toBe("reference_null");
  });

  it("carries the locator through as the PR url and preserves input order within a group", () => {
    const groups = groupPullRequestReferences([
      row({ id: "reference_1", lifecycle: "asserted", locator: "https://github.com/a/b/pull/1" }),
      row({ id: "reference_2", lifecycle: "asserted", locator: "https://github.com/a/b/pull/2" }),
    ]);

    expect(groups[0].prs.map((p) => p.url)).toEqual([
      "https://github.com/a/b/pull/1",
      "https://github.com/a/b/pull/2",
    ]);
    expect(groups[0].prs.map((p) => p.id)).toEqual(["reference_1", "reference_2"]);
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
      lifecycle: "asserted",
      total_count: "2",
      ...over,
    };
  }

  it("caps the rows shown but reports the true total via COUNT(*) OVER()", async () => {
    // The query returns the latest `limit + 1` rows, each carrying the windowed
    // total (a bigint, which pg hands back as a string). With limit 1 only one
    // row is shown, but totalCount reflects the full 1,203-row domain.
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
    expect(captured[0].sql).toMatch(/COUNT\(\*\) OVER\(\)/);
    expect(captured[0].params).toEqual(["doco_1", 2]);
    expect(data.loadedCount).toBe(1);
    expect(data.totalCount).toBe(1203);
    expect(data.hasMore).toBe(true);
    expect(data.groups[0].prs).toHaveLength(1);
  });

  it("reports hasMore=false and the true total when every PR fits", async () => {
    const { client } = makeClient([
      prRow({ id: "reference_1", total_count: "2" }),
      prRow({
        id: "reference_2",
        locator: "https://github.com/acme/web/pull/2",
        total_count: "2",
      }),
    ]);

    const data = await loadPullRequestsPerspective(client, "doco_1", { limit: 5 });

    expect(data.loadedCount).toBe(2);
    expect(data.totalCount).toBe(2);
    expect(data.hasMore).toBe(false);
  });

  it("returns a zero total and no groups when the Doco has no PRs", async () => {
    const { client } = makeClient([]);

    const data = await loadPullRequestsPerspective(client, "doco_1", { limit: 5 });

    expect(data.totalCount).toBe(0);
    expect(data.loadedCount).toBe(0);
    expect(data.hasMore).toBe(false);
    expect(data.groups).toEqual([]);
  });
});
