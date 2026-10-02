// What a Doco brings from GitHub decides which repo events reach it and which
// other Docos a repo moves away from. PGlite runs the real schema and the
// real connection + routing SQL.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import {
  addConnection,
  connectPicked,
  connectRepositories,
  detachReposEverywhere,
  getDocoConnectionsContext,
  listConnections,
  listInstallations,
  pickConnections,
  removeConnection,
  restartSkippedImports,
  setBackfillState,
  subscribeInstallation,
  unsubscribeInstallationEverywhere,
} from "../github-connection.server";
import { findDocoByInstallation, findDocoTargetsForGitHubRepo } from "../github-webhook.server";

const REPO = "acme/app";
const conn = { repo: REPO, installation_id: 9 };

beforeEach(async () => {
  const db = await freshDb();
  state.db = db;
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_prs', 'acme-pull-requests', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "github-pull-requests"}'),
      ('doco_prs2', 'acme-prs-2', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "github-pull-requests"}'),
      ('doco_legacy', 'acme-legacy', 'workspace_acme', 'workspace_acme', '{}'),
      ('doco_bugs', 'acme-github-bugs', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "github-bugs"}'),
      ('doco_code', 'acme-codebase', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "codebase"}'),
      ('doco_code2', 'acme-codebase-2', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "codebase"}');
  `);
});

const handles = (docos: Array<{ handle: string }>) => docos.map((d) => d.handle).sort();

describe("one repo per thing brought", () => {
  it("lets a repo feed a pull requests Doco and a GitHub bugs Doco at once", async () => {
    await addConnection("doco_prs", conn);
    await addConnection("doco_bugs", conn);
    expect(await listConnections("doco_prs")).toEqual([conn]);
    expect(await listConnections("doco_bugs")).toEqual([conn]);
  });

  it("still moves a repo between two Docos that bring the same thing", async () => {
    await addConnection("doco_prs", conn);
    await addConnection("doco_bugs", conn);
    await addConnection("doco_prs2", conn);
    expect(await listConnections("doco_prs")).toEqual([]);
    expect(await listConnections("doco_prs2")).toEqual([conn]);
    expect(await listConnections("doco_bugs")).toEqual([conn]);
  });

  it("counts a Doco of any other template as bringing pull requests", async () => {
    await addConnection("doco_legacy", conn);
    await addConnection("doco_prs", conn);
    expect(await listConnections("doco_legacy")).toEqual([]);
  });

  it("keeps an org subscription per thing brought too", async () => {
    const sub = { installation_id: 9, account: "acme" };
    await subscribeInstallation("doco_prs", sub);
    await subscribeInstallation("doco_bugs", sub);
    await subscribeInstallation("doco_prs2", sub);
    expect(await listInstallations("doco_prs")).toEqual([]);
    expect(await listInstallations("doco_prs2")).toEqual([sub]);
    expect(await listInstallations("doco_bugs")).toEqual([sub]);
  });

  // Connecting GitHub in one workspace once emptied other workspaces' Docos of
  // the same repositories, and the codebase Docos lost their files with them.
  it("never takes a repo, an org or its files from another workspace's Doco", async () => {
    await state.db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_zeta', 'zeta', 'Zeta');
      INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
        ('doco_zeta_prs', 'zeta-pull-requests', 'workspace_zeta', 'workspace_zeta', 'private',
          '{"template_handle": "github-pull-requests"}'),
        ('doco_zeta_code', 'zeta-codebase', 'workspace_zeta', 'workspace_zeta', 'private',
          '{"template_handle": "codebase"}');
    `);
    const sub = { installation_id: 9, account: "acme" };
    await addConnection("doco_zeta_prs", conn);
    await subscribeInstallation("doco_zeta_prs", sub);
    await addConnection("doco_zeta_code", conn);
    await state.db.exec(`
      INSERT INTO code_files (doco_id, repo, path, sha, size, content)
      VALUES ('doco_zeta_code', '${REPO}', 'README.md', 'abc', 5, 'hello');
    `);

    await addConnection("doco_prs", conn);
    await subscribeInstallation("doco_prs", sub);
    await addConnection("doco_code", conn);

    expect(await listConnections("doco_zeta_prs")).toEqual([conn]);
    expect(await listInstallations("doco_zeta_prs")).toEqual([sub]);
    expect(await listConnections("doco_zeta_code")).toEqual([conn]);
    const files = await state.db.query(
      `SELECT path FROM code_files WHERE doco_id = 'doco_zeta_code'`,
    );
    expect(files.rows).toEqual([{ path: "README.md" }]);
    // Both workspaces hear about the repo's pull requests.
    expect(handles(await findDocoTargetsForGitHubRepo(9, REPO, "github-pull-requests"))).toEqual([
      "acme-pull-requests",
      "zeta-pull-requests",
    ]);
  });
});

describe("routing repo events", () => {
  it("sends each event only to the Docos that bring its kind of item", async () => {
    await addConnection("doco_prs", conn);
    await addConnection("doco_bugs", conn);
    expect(handles(await findDocoTargetsForGitHubRepo(9, REPO, "github-pull-requests"))).toEqual([
      "acme-pull-requests",
    ]);
    expect(handles(await findDocoTargetsForGitHubRepo(9, REPO, "github-bugs"))).toEqual([
      "acme-github-bugs",
    ]);
  });

  it("names what each org-subscribed Doco brings", async () => {
    const sub = { installation_id: 9, account: "acme" };
    await subscribeInstallation("doco_prs", sub);
    await subscribeInstallation("doco_bugs", sub);
    const docos = await findDocoByInstallation(9);
    expect(docos.map((d) => [d.handle, d.template]).sort()).toEqual([
      ["acme-github-bugs", "github-bugs"],
      ["acme-pull-requests", "github-pull-requests"],
    ]);
  });
});

describe("connecting repositories", () => {
  const acme = {
    installation_id: 9,
    account: "acme",
    repositories: ["acme/app", "acme/api"],
    connected_repositories: [],
    source_doco_handles: [],
  };
  const zeta = { ...acme, installation_id: 7, account: "zeta", repositories: ["zeta/web"] };
  const empty = {
    ...acme,
    installation_id: 5,
    account: "empty",
    repository_selection: "all" as const,
    repositories: [],
  };

  it("picks repositories from every organization at once, each through its own installation", () => {
    expect(
      pickConnections([acme, zeta], {
        repos: [" acme/app ", "https://github.com/zeta/web", "acme/app"],
        installations: [],
      }),
    ).toEqual({
      connections: [
        { repo: "acme/app", installation_id: 9 },
        { repo: "zeta/web", installation_id: 7 },
      ],
      installations: [],
    });
  });

  it("picks a whole organization: every repository it lists now, and its later ones", () => {
    const selected = { ...zeta, repository_selection: "selected" as const };
    expect(
      pickConnections([acme, selected, empty], {
        repos: ["acme/api"],
        installations: ["9", "7", "5"],
      }),
    ).toEqual({
      connections: [
        { repo: "acme/api", installation_id: 9 },
        { repo: "acme/app", installation_id: 9 },
        { repo: "zeta/web", installation_id: 7 },
      ],
      installations: [acme, selected, empty],
    });
  });

  it("never connects what the user's installations don't offer", () => {
    expect(pickConnections([acme], { repos: [], installations: [] })).toEqual({
      error: "Pick at least one repository.",
    });
    expect(pickConnections([acme], { repos: ["acme/other"], installations: [] })).toEqual({
      error: "acme/other is not available from your GitHub connections.",
    });
    expect(pickConnections([acme], { repos: [], installations: ["404"] })).toEqual({
      error: "That GitHub connection is not available to your account.",
    });
  });

  it("connects a picked organization whole: subscribed, with its repositories importing", async () => {
    const picked = pickConnections([acme], { repos: [], installations: ["9"] });
    if ("error" in picked) throw new Error(picked.error);
    expect(await connectPicked("doco_prs", picked)).toBe(true);
    expect(await listInstallations("doco_prs")).toEqual([
      expect.objectContaining({ installation_id: 9, account: "acme" }),
    ]);
    const ctx = await getDocoConnectionsContext("doco_prs");
    expect(ctx?.connections.map((c) => c.repo)).toEqual(["acme/app", "acme/api"]);
    expect(ctx?.backfill).toMatchObject({ status: "running", queue: ["acme/app", "acme/api"] });
  });

  it("subscribes an organization with no repositories yet, with no import to start", async () => {
    const picked = pickConnections([empty], { repos: [], installations: ["5"] });
    if ("error" in picked) throw new Error(picked.error);
    expect(await connectPicked("doco_prs", picked)).toBe(false);
    expect(await listInstallations("doco_prs")).toEqual([
      expect.objectContaining({ installation_id: 5, account: "empty" }),
    ]);
    expect(await listConnections("doco_prs")).toEqual([]);
  });

  it("connects each repository and queues its import", async () => {
    await connectRepositories("doco_bugs", [
      { repo: "acme/app", installation_id: 9 },
      { repo: "zeta/web", installation_id: 7 },
    ]);
    const ctx = await getDocoConnectionsContext("doco_bugs");
    expect(ctx?.template).toBe("github-bugs");
    expect(ctx?.connections.map((c) => [c.repo, c.installation_id])).toEqual([
      ["acme/app", 9],
      ["zeta/web", 7],
    ]);
    expect(ctx?.backfill).toMatchObject({
      status: "running",
      queue: ["acme/app", "zeta/web"],
      repos: 2,
      repo_index: 0,
      page: 1,
    });
  });

  it("adds new repositories to the end of an import already under way", async () => {
    await connectRepositories("doco_code", [{ repo: "acme/app", installation_id: 9 }]);
    const running = (await getDocoConnectionsContext("doco_code"))?.backfill;
    await setBackfillState("doco_code", { ...running, status: "running", page: 4, imported: 120 });
    await connectRepositories("doco_code", [{ repo: "acme/api", installation_id: 9 }]);
    expect((await getDocoConnectionsContext("doco_code"))?.backfill).toMatchObject({
      status: "running",
      queue: ["acme/app", "acme/api"],
      repos: 2,
      repo_index: 0,
      page: 4,
      imported: 120,
    });
  });

  it("starts a fresh import once the previous one finished", async () => {
    await connectRepositories("doco_code", [{ repo: "acme/app", installation_id: 9 }]);
    await setBackfillState("doco_code", { status: "done", imported: 50, queue: ["acme/app"] });
    await connectRepositories("doco_code", [{ repo: "acme/api", installation_id: 9 }]);
    expect((await getDocoConnectionsContext("doco_code"))?.backfill).toMatchObject({
      status: "running",
      queue: ["acme/api"],
      repos: 1,
      repo_index: 0,
      imported: 0,
    });
  });
});

describe("once GitHub grants Doco more access", () => {
  const refused = {
    repo: "acme/app",
    message: "failed: 403",
    at: "2026-10-01T00:00:00Z",
    status: 403,
  };

  it("imports again every Doco connected through it that skipped a repository", async () => {
    await connectRepositories("doco_code", [
      { repo: "acme/app", installation_id: 9 },
      { repo: "acme/api", installation_id: 9 },
    ]);
    await setBackfillState("doco_code", {
      status: "done",
      repos: 2,
      skipped: 2,
      errors: [refused],
    });
    // Skipped nothing: nothing to import again.
    await connectRepositories("doco_prs", [{ repo: "acme/app", installation_id: 9 }]);
    await setBackfillState("doco_prs", { status: "done", repos: 1 });
    // Connected through another installation.
    await connectRepositories("doco_bugs", [{ repo: "zeta/web", installation_id: 7 }]);
    await setBackfillState("doco_bugs", {
      status: "done",
      repos: 1,
      skipped: 1,
      errors: [refused],
    });

    expect(await restartSkippedImports(9)).toEqual(["doco_code"]);
    expect((await getDocoConnectionsContext("doco_code"))?.backfill).toMatchObject({
      status: "running",
      queue: ["acme/app", "acme/api"],
      repo_index: 0,
    });
    expect((await getDocoConnectionsContext("doco_code"))?.backfill?.errors).toBeUndefined();
    expect((await getDocoConnectionsContext("doco_bugs"))?.backfill?.status).toBe("done");
  });
});

describe("the copied code follows the connections", () => {
  const copyFile = (docoId: string, repo: string) =>
    state.db.query(
      `INSERT INTO code_files (doco_id, repo, path, sha, size) VALUES ($1, $2, 'a.ts', 'x', 1)`,
      [docoId, repo],
    );
  const copiedRepos = async (docoId: string) =>
    (
      await state.db.query<{ repo: string }>(
        "SELECT repo FROM code_files WHERE doco_id = $1 ORDER BY repo",
        [docoId],
      )
    ).rows.map((r) => r.repo);

  it("drops a repository's files when it is disconnected", async () => {
    await addConnection("doco_code", conn);
    await addConnection("doco_code", { repo: "acme/api", installation_id: 9 });
    await copyFile("doco_code", REPO);
    await copyFile("doco_code", "acme/api");
    await removeConnection("doco_code", REPO);
    expect(await copiedRepos("doco_code")).toEqual(["acme/api"]);
  });

  it("drops them from the codebase Doco a repository moves away from", async () => {
    await addConnection("doco_code", conn);
    await copyFile("doco_code", REPO);
    await addConnection("doco_code2", conn);
    expect(await copiedRepos("doco_code")).toEqual([]);
  });

  it("drops them when access to the repository is revoked", async () => {
    await addConnection("doco_code", conn);
    await copyFile("doco_code", REPO);
    await detachReposEverywhere([REPO]);
    expect(await copiedRepos("doco_code")).toEqual([]);
  });

  it("keeps the files of an organization the Doco subscribes to, until it is uninstalled", async () => {
    await subscribeInstallation("doco_code", { installation_id: 9, account: "Acme" });
    await copyFile("doco_code", REPO);
    await removeConnection("doco_code", "acme/other");
    expect(await copiedRepos("doco_code")).toEqual([REPO]);
    await unsubscribeInstallationEverywhere(9);
    expect(await copiedRepos("doco_code")).toEqual([]);
  });
});
