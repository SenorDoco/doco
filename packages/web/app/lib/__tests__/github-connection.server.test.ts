import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));

import { withClient } from "@doco/db";
import {
  type GitHubConnection,
  type GitHubInstallationAuthorization,
  type GitHubInstallationSub,
  addConnection,
  buildInstallUrl,
  githubImportProgress,
  githubImportState,
  githubOrgAccounts,
  groupKnownGitHubInstallations,
  importInstallationConnections,
  listGitHubInstallationChoicesForDocos,
  normalizeBackfillState,
  normalizeConnections,
  normalizeInstallationAuthorizations,
  normalizeInstallations,
  parseRepoSlug,
  reconcileInstallationConnections,
  recordInstallationAuthorization,
  resumeCursorFromConnections,
  signInstallState,
  subscribeInstallation,
  summarizeBackfillForStatus,
  verifyInstallState,
} from "../github-connection.server";

describe("reconcileInstallationConnections", () => {
  it("re-lists each organization the Doco subscribes to as a whole", async () => {
    const importRepos = vi.fn(async () => ({ repos: [] }));
    const ids = await reconcileInstallationConnections(
      "doco_1",
      [
        { installation_id: 7, account: "acme" },
        { installation_id: 9, account: "zeta" },
      ],
      { importRepos: importRepos as never },
    );
    expect(ids).toEqual([7, 9]);
    expect(importRepos).toHaveBeenCalledWith({ docoId: "doco_1", installationId: 7 });
    expect(importRepos).toHaveBeenCalledWith({ docoId: "doco_1", installationId: 9 });
  });
  it("never adds repositories to a Doco that picked its repositories one by one", async () => {
    const importRepos = vi.fn(async () => ({ repos: [] }));
    expect(
      await reconcileInstallationConnections("doco_1", [], { importRepos: importRepos as never }),
    ).toEqual([]);
    expect(importRepos).not.toHaveBeenCalled();
  });
  it("skips a failing installation instead of throwing", async () => {
    const importRepos = vi
      .fn()
      .mockRejectedValueOnce(new Error("bad token"))
      .mockResolvedValueOnce({ repos: ["acme/a"] });
    const ids = await reconcileInstallationConnections(
      "doco_1",
      [
        { installation_id: 1, account: "acme" },
        { installation_id: 2, account: "zeta" },
      ],
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
    });
    expect(cur).toMatchObject({
      started_at: "2026-01-01T00:00:00.000Z",
      imported: 4200,
      updated: 7,
      unchanged: 12,
      failed: 1,
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

describe("normalizeInstallationAuthorizations", () => {
  it("reads the repo-picker authorization shape", () => {
    expect(
      normalizeInstallationAuthorizations({
        installation_authorizations: [
          { installation_id: 5, account: "acme", repository_selection: "all" },
        ],
      }),
    ).toEqual([{ installation_id: 5, account: "acme", repository_selection: "all" }]);
  });

  it("makes authorized installations reusable choices without subscribing every repo", () => {
    expect(
      groupKnownGitHubInstallations([
        {
          handle: "new-prs",
          githubIntegration: {
            installation_authorizations: [{ installation_id: 42, account: "acme" }],
          },
        },
      ]),
    ).toEqual([
      {
        installation_id: 42,
        account: "acme",
        connected_repositories: [],
        source_doco_handles: ["new-prs"],
      },
    ]);
  });
});

describe("listGitHubInstallationChoicesForDocos", () => {
  afterEach(() => {
    vi.mocked(withClient).mockReset();
  });

  it("refreshes installation metadata and passes all-repo selection to the GitHub repo lister", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          handle: "meta-pull-requests",
          gh: {
            installation_authorizations: [{ installation_id: 42, account: "Doco-to" }],
          },
        },
      ],
    }));
    vi.mocked(withClient).mockImplementation(async (callback) => callback({ query } as never));
    const getInstallation = vi.fn(async () => ({
      account: "Doco-to",
      repository_selection: "all" as const,
    }));
    const mintToken = vi.fn(async () => ({ token: "ghs_x", expires_at: "" }));
    const listRepos = vi.fn(async () => ["Doco-to/doco"]);

    const choices = await listGitHubInstallationChoicesForDocos(["doco_1"], {
      getInstallation: getInstallation as never,
      mintToken: mintToken as never,
      listRepos: listRepos as never,
    });

    expect(listRepos).toHaveBeenCalledWith("ghs_x", {
      account: "Doco-to",
      repositorySelection: "all",
    });
    expect(choices).toEqual([
      expect.objectContaining({
        account: "Doco-to",
        repository_selection: "all",
        repositories: ["Doco-to/doco"],
      }),
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
  it("carries the resilience cursor: attempts, retry_after, and validated errors[]", () => {
    const state = normalizeBackfillState({
      backfill: {
        status: "running",
        attempts: 2,
        retry_after: "2026-06-01T00:05:00.000Z",
        errors: [
          { repo: "acme/gone", page: 7, message: "GitHub GET … failed: 404", at: "t1" },
          { not: "an error" }, // malformed — must be dropped
        ],
      },
    });
    expect(state).toMatchObject({
      status: "running",
      attempts: 2,
      retry_after: "2026-06-01T00:05:00.000Z",
      errors: [{ repo: "acme/gone", page: 7, message: "GitHub GET … failed: 404", at: "t1" }],
    });
  });
});

describe("githubImportProgress", () => {
  it("reports repos done of total for a running backfill", () => {
    expect(
      githubImportProgress({ status: "running", repos: 4, repo_index: 2, imported: 137 }),
    ).toEqual({ done: 2, total: 4 });
  });
  it("treats a not-yet-advanced cursor as 0 of total", () => {
    expect(githubImportProgress({ status: "running", repos: 3, repo_index: 0 })).toEqual({
      done: 0,
      total: 3,
    });
    expect(githubImportProgress({ status: "running", repos: 3 })).toEqual({ done: 0, total: 3 });
  });
  it("clamps a drained cursor (repo_index ≥ total) to total", () => {
    // A slice that just finished the last repo can leave repo_index === total
    // (or beyond) for a tick before the marker flips to "done".
    expect(githubImportProgress({ status: "running", repos: 4, repo_index: 4 })).toEqual({
      done: 4,
      total: 4,
    });
    expect(githubImportProgress({ status: "running", repos: 4, repo_index: 9 })).toEqual({
      done: 4,
      total: 4,
    });
  });
  it("is null when the total repo count is unknown — nothing to count out of", () => {
    expect(githubImportProgress({ status: "running", repo_index: 1 })).toBeNull();
    expect(githubImportProgress({ status: "running", repos: 0 })).toBeNull();
  });
  it("is null for a finished or absent backfill", () => {
    expect(githubImportProgress({ status: "done", repos: 4, repo_index: 4 })).toBeNull();
    expect(githubImportProgress(null)).toBeNull();
  });
});

describe("summarizeBackfillForStatus", () => {
  const now = Date.parse("2026-06-02T00:00:00.000Z");

  it("maps a running import and flags a fresh cursor as not stalled", () => {
    const s = summarizeBackfillForStatus(
      {
        status: "running",
        repos: 10,
        repo_index: 3,
        imported: 5000,
        updated: 2,
        unchanged: 9,
        failed: 1,
        started_at: "2026-06-01T00:00:00.000Z",
        cursor_at: "2026-06-01T23:59:00.000Z", // one minute before `now`
      },
      now,
    );
    expect(s).toMatchObject({
      status: "running",
      imported: 5000,
      updated: 2,
      unchanged: 9,
      failed: 1,
      repos: 10,
      repos_done: 3,
      stalled: false,
    });
  });

  it("flags a running import whose cursor went stale (a stranded chain)", () => {
    const s = summarizeBackfillForStatus(
      { status: "running", repos: 4, repo_index: 1, cursor_at: "2026-06-01T00:00:00.000Z" },
      now, // 24h after the last cursor advance
    );
    expect(s?.stalled).toBe(true);
  });

  it("treats a running import with no cursor heartbeat as stalled", () => {
    expect(
      summarizeBackfillForStatus({ status: "running", repos: 4, repo_index: 1 }, now)?.stalled,
    ).toBe(true);
  });

  it("never flags a finished import as stalled and clamps repos_done to total", () => {
    const s = summarizeBackfillForStatus(
      { status: "done", repos: 4, repo_index: 9, imported: 12, finished_at: "t" },
      now,
    );
    expect(s).toMatchObject({
      status: "done",
      repos: 4,
      repos_done: 4,
      imported: 12,
      stalled: false,
    });
  });

  it("is null when there is no backfill marker", () => {
    expect(summarizeBackfillForStatus(null, now)).toBeNull();
  });
});

describe("githubImportState", () => {
  const now = Date.parse("2026-09-27T15:00:00.000Z");
  const repo = { connections: [{ repo: "acme/store", installation_id: 7 }] };

  it("is null when nothing is connected — no status on a plain Doco", () => {
    expect(githubImportState(null, now)).toBeNull();
    expect(githubImportState({}, now)).toBeNull();
    expect(githubImportState({ connections: [], installations: [] }, now)).toBeNull();
  });
  it("is done for a repo connection with no backfill", () => {
    expect(githubImportState(repo, now)).toEqual({
      state: "done",
      reposDone: 0,
      repos: 0,
      skipped: 0,
      refused: false,
    });
  });
  it("counts an org-wide installation as connected even before any repo syncs", () => {
    expect(
      githubImportState({ installations: [{ installation_id: 7, account: "acme" }] }, now),
    ).toEqual({ state: "done", reposDone: 0, repos: 0, skipped: 0, refused: false });
  });
  it("reports repos imported while a backfill is running", () => {
    expect(
      githubImportState(
        {
          ...repo,
          backfill: {
            status: "running",
            repos: 3,
            repo_index: 1,
            cursor_at: "2026-09-27T14:59:00.000Z",
          },
        },
        now,
      ),
    ).toEqual({ state: "importing", reposDone: 1, repos: 3, skipped: 0, refused: false });
  });
  it("is stalled when a running backfill stopped advancing", () => {
    expect(
      githubImportState(
        {
          ...repo,
          backfill: { status: "running", repos: 3, cursor_at: "2026-09-27T14:00:00.000Z" },
        },
        now,
      )?.state,
    ).toBe("stalled");
  });
  it("counts the repos it skipped, and whether GitHub refused Doco access to one", () => {
    const error = { repo: "acme/a", message: "failed: 403", at: "2026-09-27T14:00:00.000Z" };
    expect(
      githubImportState(
        {
          ...repo,
          backfill: { status: "done", repos: 3, skipped: 2, errors: [{ ...error, status: 403 }] },
        },
        now,
      ),
    ).toMatchObject({ state: "done", skipped: 2, refused: true });
    // A marker from before the count was kept counts the repos it names.
    expect(
      githubImportState(
        {
          ...repo,
          backfill: { status: "done", repos: 3, errors: [{ ...error, status: 404 }] },
        },
        now,
      ),
    ).toMatchObject({ skipped: 1, refused: false });
  });
  it("is done once the backfill is done", () => {
    expect(
      githubImportState({ ...repo, backfill: { status: "done", imported: 12 } }, now)?.state,
    ).toBe("done");
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
  beforeEach(() => {
    vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const target = { userId: "user_1", docoIds: ["doco_1", "doco_2"], next: "/integrations/github" };
  it("builds the install URL with a sealed state binding the Docos, the installer and the way back", () => {
    vi.stubEnv("DOCO_GITHUB_APP_SLUG", "doco-pr-sync");
    vi.stubEnv("DOCO_GITHUB_APP_CLIENT_SECRET", "app-secret");
    const url = new URL(buildInstallUrl(target) ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://github.com/apps/doco-pr-sync/installations/new",
    );
    expect(verifyInstallState(url.searchParams.get("state") ?? "")).toEqual(target);
  });
  it("returns null when the slug isn't configured", () => {
    vi.stubEnv("DOCO_GITHUB_APP_SLUG", "");
    vi.stubEnv("DOCO_GITHUB_APP_CLIENT_SECRET", "app-secret");
    expect(buildInstallUrl(target)).toBeNull();
  });
  it("returns null when the App's client secret (needed to verify the install) isn't configured", () => {
    vi.stubEnv("DOCO_GITHUB_APP_SLUG", "doco-pr-sync");
    vi.stubEnv("DOCO_GITHUB_APP_CLIENT_SECRET", "");
    expect(buildInstallUrl(target)).toBeNull();
  });
});

describe("verifyInstallState", () => {
  beforeEach(() => {
    vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const now = Date.UTC(2026, 8, 26, 12);
  const state = { userId: "user_1", docoIds: ["doco_1"], next: "/prs/integrations/github" };

  it("round-trips a fresh state", () => {
    expect(verifyInstallState(signInstallState(state, now), now + 60_000)).toEqual(state);
  });
  it("rejects a bare Doco id (the old unsigned state)", () => {
    expect(verifyInstallState("doco_1", now)).toBeNull();
  });
  it("rejects a state whose payload was swapped", () => {
    const [head, tag] = signInstallState(state, now).split(".");
    const [, , body] = signInstallState({ ...state, docoIds: ["doco_2"] }, now).split(".");
    expect(verifyInstallState(`${head}.${tag}.${body}`, now)).toBeNull();
  });
  it("rejects a state older than an hour", () => {
    expect(verifyInstallState(signInstallState(state, now), now + 61 * 60_000)).toBeNull();
  });
  it("rejects a state that names no Doco or would send the user off the site", () => {
    for (const bad of [
      { ...state, docoIds: [] },
      { ...state, next: "https://evil.example/" },
      { ...state, next: "//evil.example/" },
      { ...state, next: "/\\evil.example/" },
    ]) {
      expect(verifyInstallState(signInstallState(bad, now), now), JSON.stringify(bad)).toBeNull();
    }
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

describe("recordInstallationAuthorization", () => {
  it("records an available GitHub installation without detaching it from other Docos", async () => {
    const list = vi.fn(
      async () => [{ installation_id: 1, account: "old" }] as GitHubInstallationAuthorization[],
    );
    const write = vi.fn(async (_id: string, _auths: GitHubInstallationAuthorization[]) => {});

    const result = await recordInstallationAuthorization(
      "doco_1",
      { installation_id: 5, account: "acme" },
      { list, write },
    );

    expect(write).toHaveBeenCalledWith("doco_1", [
      { installation_id: 1, account: "old" },
      { installation_id: 5, account: "acme" },
    ]);
    expect(result).toEqual([
      { installation_id: 1, account: "old" },
      { installation_id: 5, account: "acme" },
    ]);
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
