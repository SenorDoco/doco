// What a Doco brings from GitHub decides which repo events reach it and which
// other Docos a repo moves away from. PGlite runs the real schema and the
// real connection + routing SQL.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));

import {
  addConnection,
  connectRepositories,
  detachReposEverywhere,
  getDocoConnectionsContext,
  listConnections,
  listInstallations,
  pickRepositories,
  removeConnection,
  subscribeInstallation,
  unsubscribeInstallationEverywhere,
} from "../github-connection.server";
import { findDocoByInstallation, findDocoTargetsForGitHubRepo } from "../github-webhook.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const REPO = "acme/app";
const conn = { repo: REPO, installation_id: 9 };

beforeEach(async () => {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  state.db = db;
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_prs', 'acme-pull-requests', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "github-pull-requests"}'),
      ('doco_prs2', 'acme-prs-2', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "github-pull-requests"}'),
      ('doco_legacy', 'acme-legacy', 'workspace_acme', 'workspace_acme', '{}'),
      ('doco_bugs', 'acme-bugs', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "bugs"}'),
      ('doco_code', 'acme-codebase', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "codebase"}'),
      ('doco_code2', 'acme-codebase-2', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "codebase"}');
  `);
});

const handles = (docos: Array<{ handle: string }>) => docos.map((d) => d.handle).sort();

describe("one repo per thing brought", () => {
  it("lets a repo feed a pull requests Doco and a Bug tracker at once", async () => {
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
});

describe("routing repo events", () => {
  it("sends each event only to the Docos that bring its kind of item", async () => {
    await addConnection("doco_prs", conn);
    await addConnection("doco_bugs", conn);
    expect(handles(await findDocoTargetsForGitHubRepo(9, REPO, "github-pull-requests"))).toEqual([
      "acme-pull-requests",
    ]);
    expect(handles(await findDocoTargetsForGitHubRepo(9, REPO, "bugs"))).toEqual(["acme-bugs"]);
  });

  it("names what each org-subscribed Doco brings", async () => {
    const sub = { installation_id: 9, account: "acme" };
    await subscribeInstallation("doco_prs", sub);
    await subscribeInstallation("doco_bugs", sub);
    const docos = await findDocoByInstallation(9);
    expect(docos.map((d) => [d.handle, d.template]).sort()).toEqual([
      ["acme-bugs", "bugs"],
      ["acme-pull-requests", "github-pull-requests"],
    ]);
  });
});

describe("connecting repositories", () => {
  const choice = {
    installation_id: 9,
    account: "acme",
    repositories: ["acme/app", "acme/api"],
    connected_repositories: [],
    source_doco_handles: [],
  };

  it("picks only repositories the installation offers", () => {
    expect(
      pickRepositories(choice, [" acme/app ", "https://github.com/acme/api", "acme/app"]),
    ).toEqual({
      repos: ["acme/app", "acme/api"],
    });
    expect(pickRepositories(choice, [])).toEqual({ error: "Pick at least one repository." });
    expect(pickRepositories(choice, ["acme/other"])).toEqual({
      error: "acme/other is not available from the selected GitHub connection.",
    });
  });

  it("connects each repository and queues its import", async () => {
    await connectRepositories("doco_bugs", 9, ["acme/app", "acme/api"]);
    const ctx = await getDocoConnectionsContext("doco_bugs");
    expect(ctx?.template).toBe("bugs");
    expect(ctx?.connections.map((c) => c.repo)).toEqual(["acme/app", "acme/api"]);
    expect(ctx?.backfill).toMatchObject({
      status: "running",
      queue: ["acme/app", "acme/api"],
      repos: 2,
      installation_id: 9,
      repo_index: 0,
      page: 1,
    });
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
