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

  it("caps the PR rows serialized into the page and detects more without counting them all", async () => {
    const captured: { sql: string; params?: unknown[] }[] = [];
    const client = {
      async query<T>(sql: string, params?: unknown[]) {
        captured.push({ sql, params });
        return {
          rows: [
            {
              id: "reference_1",
              reference: "Merged PR",
              locator: "https://github.com/acme/web/pull/1",
              lifecycle: "asserted",
            },
            {
              id: "reference_2",
              reference: "Another PR",
              locator: "https://github.com/acme/web/pull/2",
              lifecycle: "asserted",
            },
          ] as T[],
        };
      },
    };

    const data = await loadPullRequestsPerspective(client, "doco_1", { limit: 1 });

    expect(captured[0].sql).toMatch(/LIMIT \$2/);
    expect(captured[0].sql).not.toMatch(/COUNT\(\*\) OVER/);
    expect(captured[0].params).toEqual(["doco_1", 2]);
    expect(data.loadedCount).toBe(1);
    expect(data.hasMore).toBe(true);
    expect(data.groups[0].prs).toHaveLength(1);
  });
});
