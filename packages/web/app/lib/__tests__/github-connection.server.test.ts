import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import { withClient } from "@doco/db";
import {
  type GitHubConnection,
  type GitHubInstallationSub,
  addConnection,
  buildInstallUrl,
  githubOrgAccounts,
  groupKnownGitHubInstallations,
  importInstallationConnections,
  normalizeBackfillState,
  normalizeConnections,
  normalizeInstallations,
  parseRepoSlug,
  reconcileInstallationConnections,
  resumeCursorFromConnections,
  subscribeInstallation,
} from "../github-connection.server";

describe("reconcileInstallationConnections", () => {
  it("re-imports each DISTINCT installation id from subs + connections", async () => {
    const importRepos = vi.fn(async () => ({ repos: [] }));
    const ids = await reconcileInstallationConnections(
      "doco_1",
      {
        installations: [{ installation_id: 7, account: "acme" }],
        connections: [
          { repo: "acme/a", installation_id: 7 },
          { repo: "zeta/b", installation_id: 9 },
        ],
      },
      { importRepos: importRepos as never },
    );
    expect(ids).toEqual([7, 9]);
    expect(importRepos).toHaveBeenCalledTimes(2);
    expect(importRepos).toHaveBeenCalledWith({ docoId: "doco_1", installationId: 7 });
    expect(importRepos).toHaveBeenCalledWith({ docoId: "doco_1", installationId: 9 });
  });
  it("skips a failing installation instead of throwing", async () => {
    const importRepos = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad token"))
      .mockResolvedValueOnce({ repos: ["acme/a"] });
    const ids = await reconcileInstallationConnections(
      "doco_1",
      {
        installations: [],
        connections: [
          { repo: "acme/a", installation_id: 1 },
          { repo: "acme/b", installation_id: 2 },
        ],
      },
      { importRepos: importRepos as never },
    );
    expect(ids).toEqual([1, 2]);
    expect(importRepos).toHaveBeenCalledTimes(2);
  });
});

describe("resumeCursorFromConnections", () => {
  const conns: GitHubConnection[] = [
    { repo: "acme/store", installation_id: 42 },
    { repo: "acme/web", installation_id: 42 },
  ];
  it("rebuilds a running cursor whose queue is every connected repo, reset to the start", () => {
    const cur = resumeCursorFromConnections(conns);
    expect(cur).toMatchObject({
      status: "running",
      queue: ["acme/store", "acme/web"],
      repo_index: 0,
      page: 1,
      repos: 2,
      installation_id: 42,
    });
    expect(typeof cur.cursor_at).toBe("string");
    expect(typeof cur.started_at).toBe("string");
  });
  it("carries forward tallies and started_at from a prior (stranded) marker", () => {
    const cur = resumeCursorFromConnections(conns, {
      status: "running",
      started_at: "2026-01-01T00:00:00.000Z",
      imported: 4200,
      updated: 7,
      unchanged: 12,
      failed: 1,
      installation_id: 99,
    });
    expect(cur).toMatchObject({
      started_at: "2026-01-01T00:00:00.000Z",
      imported: 4200,
      updated: 7,
      unchanged: 12,
      failed: 1,
      installation_id: 99,
      repo_index: 0,
      page: 1,
    });
  });
  it("yields an empty queue when nothing is connected", () => {
    expect(resumeCursorFromConnections([]).queue).toEqual([]);
  });
});

describe("githubOrgAccounts", () => {
  it("derives owners from connected repos when there are no installation subs", () => {
    expect(
      githubOrgAccounts({
        installations: [],
        connections: [
          { repo: "acme/store", installation_id: 1 },
          { repo: "acme/web", installation_id: 1 },
        ],
      }),
    ).toEqual(["acme"]);
  });
  it("prefers installation account logins and merges with repo owners, de-duped + sorted", () => {
    expect(
      githubOrgAccounts({
        installations: [{ installation_id: 1, account: "acme" }],
        connections: [
          { repo: "acme/store", installation_id: 1 },
          { repo: "zeta/api", installation_id: 2 },
        ],
      }),
    ).toEqual(["acme", "zeta"]);
  });
  it("is empty when nothing is connected", () => {
    expect(githubOrgAccounts({ installations: [], connections: [] })).toEqual([]);
  });
});

describe("groupKnownGitHubInstallations", () => {
  it("groups installation orgs, repositories, and source Docos", () => {
    expect(
      groupKnownGitHubInstallations([
        {
          handle: "one-prs",
          githubIntegration: {
            installations: [{ installation_id: 42, account: "acme" }],
            connections: [{ repo: "acme/web", installation_id: 42 }],
          },
        },
        {
          handle: "two-prs",
          githubIntegration: {
            connections: [
              { repo: "acme/api", installation_id: 42 },
              { repo: "zeta/docs", installation_id: 7 },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        installation_id: 42,
        account: "acme",
        connected_repositories: ["acme/api", "acme/web"],
        source_doco_handles: ["one-prs", "two-prs"],
      },
      {
        installation_id: 7,
        account: "zeta",
        connected_repositories: ["zeta/docs"],
        source_doco_handles: ["two-prs"],
      },
    ]);
  });
});

describe("normalizeBackfillState", () => {
  it("reads a running / done marker", () => {
    expect(
      normalizeBackfillState({ backfill: { status: "running", repos: 3, started_at: "t" } }),
    ).toEqual({ status: "running", repos: 3, started_at: "t" });
    expect(normalizeBackfillState({ backfill: { status: "done", imported: 12 } })).toEqual({
      status: "done",
      imported: 12,
    });
  });
  it("returns null for missing / invalid markers", () => {
    expect(normalizeBackfillState(null)).toBeNull();
    expect(normalizeBackfillState({})).toBeNull();
    expect(normalizeBackfillState({ backfill: { status: "bogus" } })).toBeNull();
  });
});

describe("parseRepoSlug", () => {
  it("splits owner/name", () => {
    expect(parseRepoSlug("acme/store")).toEqual({ owner: "acme", name: "store" });
  });
  it("trims surrounding whitespace", () => {
    expect(parseRepoSlug("  acme/store  ")).toEqual({ owner: "acme", name: "store" });
  });
  it("accepts a full GitHub URL", () => {
    expect(parseRepoSlug("https://github.com/acme/store")).toEqual({
      owner: "acme",
      name: "store",
    });
    expect(parseRepoSlug("https://github.com/acme/store.git")).toEqual({
      owner: "acme",
      name: "store",
    });
  });
  it("rejects malformed input", () => {
    expect(parseRepoSlug("acme")).toBeNull();
    expect(parseRepoSlug("a/b/c")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });
});

describe("normalizeConnections", () => {
  it("reads the new connections[] shape", () => {
    expect(normalizeConnections({ connections: [{ repo: "a/b", installation_id: 1 }] })).toEqual([
      { repo: "a/b", installation_id: 1 },
    ]);
  });
  it("ignores a single repo object outside connections[]", () => {
    expect(normalizeConnections({ repo: "a/b", installation_id: 2, connected_at: "t" })).toEqual(
      [],
    );
  });
  it("drops invalid entries and handles junk", () => {
    expect(normalizeConnections(null)).toEqual([]);
    expect(
      normalizeConnections({ connections: [{ repo: "a/b" }, { installation_id: 3 }] }),
    ).toEqual([]);
  });
});

describe("buildInstallUrl", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("builds the install URL with the app slug + encoded state", () => {
    process.env.DOCO_GITHUB_APP_SLUG = "doco-pr-sync";
    expect(buildInstallUrl("doco_1")).toBe(
      "https://github.com/apps/doco-pr-sync/installations/new?state=doco_1",
    );
  });
  it("returns null when the slug isn't configured", () => {
    process.env.DOCO_GITHUB_APP_SLUG = "";
    expect(buildInstallUrl("doco_1")).toBeNull();
  });
});

describe("addConnection — one repo ↔ one Doco", () => {
  it("detaches the repo from every other Doco (move) before attaching it here", async () => {
    const order: string[] = [];
    const detachElsewhere = vi.fn(async (repo: string, keep: string) => {
      order.push(`detach:${repo}:${keep}`);
    });
    const list = vi.fn(async () => [{ repo: "x/old", installation_id: 1 }] as GitHubConnection[]);
    const write = vi.fn(async (_id: string, conns: GitHubConnection[]) => {
      order.push(`write:${conns.map((c) => c.repo).join(",")}`);
    });
    const result = await addConnection(
      "doco_target",
      { repo: "acme/store", installation_id: 9 },
      { detachElsewhere, list, write },
    );
    expect(detachElsewhere).toHaveBeenCalledWith("acme/store", "doco_target");
    // Detach must happen before the write, and the existing repo is kept.
    expect(order).toEqual(["detach:acme/store:doco_target", "write:x/old,acme/store"]);
    expect(result).toEqual([
      { repo: "x/old", installation_id: 1 },
      { repo: "acme/store", installation_id: 9 },
    ]);
  });

  it("replaces a stale entry for the same repo on this Doco (no duplicate)", async () => {
    const list = vi.fn(
      async () => [{ repo: "acme/store", installation_id: 1 }] as GitHubConnection[],
    );
    const result = await addConnection(
      "doco_1",
      { repo: "acme/store", installation_id: 2 },
      { detachElsewhere: vi.fn(async () => {}), list, write: vi.fn(async () => {}) },
    );
    expect(result).toEqual([{ repo: "acme/store", installation_id: 2 }]);
  });

  it("preserves sibling github_integration fields when writing connections", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            gh: {
              installations: [{ installation_id: 42, account: "acme" }],
              connections: [],
            },
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    vi.mocked(withClient).mockImplementation(async (callback) => callback({ query } as never));

    await addConnection("doco_1", { repo: "acme/app", installation_id: 42 });

    const writeSql = String(query.mock.calls[2]?.[0]);
    expect(writeSql).toContain("jsonb_build_object");
    expect(writeSql).toContain("COALESCE(data->'github_integration'");
    vi.mocked(withClient).mockReset();
  });
});

describe("normalizeInstallations", () => {
  it("reads the installations[] org-subscription shape", () => {
    expect(
      normalizeInstallations({ installations: [{ installation_id: 5, account: "acme" }] }),
    ).toEqual([{ installation_id: 5, account: "acme" }]);
  });
  it("drops invalid entries and junk", () => {
    expect(normalizeInstallations(null)).toEqual([]);
    expect(
      normalizeInstallations({ installations: [{ account: "acme" }, { installation_id: 5 }] }),
    ).toEqual([]);
  });
});

describe("subscribeInstallation — one installation ↔ one Doco", () => {
  it("detaches the installation from other Docos, then records it here (append, dedup by id)", async () => {
    const order: string[] = [];
    const detachElsewhere = vi.fn(async (id: number, keep: string) => {
      order.push(`detach:${id}:${keep}`);
    });
    const list = vi.fn(
      async () => [{ installation_id: 1, account: "old" }] as GitHubInstallationSub[],
    );
    const write = vi.fn(async (_id: string, subs: GitHubInstallationSub[]) => {
      order.push(`write:${subs.map((s) => s.installation_id).join(",")}`);
    });
    const result = await subscribeInstallation(
      "doco_target",
      { installation_id: 5, account: "acme" },
      { detachElsewhere, list, write },
    );
    expect(detachElsewhere).toHaveBeenCalledWith(5, "doco_target");
    expect(order).toEqual(["detach:5:doco_target", "write:1,5"]);
    expect(result).toEqual([
      { installation_id: 1, account: "old" },
      { installation_id: 5, account: "acme" },
    ]);
  });

  it("replaces a stale entry for the same installation (no duplicate)", async () => {
    const list = vi.fn(
      async () => [{ installation_id: 5, account: "old-name" }] as GitHubInstallationSub[],
    );
    const result = await subscribeInstallation(
      "doco_1",
      { installation_id: 5, account: "acme" },
      { detachElsewhere: vi.fn(async () => {}), list, write: vi.fn(async () => {}) },
    );
    expect(result).toEqual([{ installation_id: 5, account: "acme" }]);
  });
});

describe("importInstallationConnections", () => {
  it("mints a token, lists the installation's repos, and connects each", async () => {
    const mintToken = vi.fn(async () => ({ token: "t", expires_at: "" }));
    const listRepos = vi.fn(async () => ["acme/a", "acme/b"]);
    const add = vi.fn(async () => []);
    const { repos } = await importInstallationConnections(
      { docoId: "doco_1", installationId: 42 },
      { mintToken: mintToken as never, listRepos: listRepos as never, add: add as never },
    );
    expect(repos).toEqual(["acme/a", "acme/b"]);
    expect(mintToken).toHaveBeenCalledWith(42);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ repo: "acme/a", installation_id: 42 }),
    );
  });
});
