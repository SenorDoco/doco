// The GitHub setup brings each choice into the workspace's Doco for it,
// creating that Doco when the workspace has none. Every choice has a Doco of
// its own: issues from GitHub never land in the Bug tracker people file bugs
// in, and come only from repositories that use GitHub issues. PGlite runs the
// real schema and the real Doco creation.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock("@doco/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@doco/db")>()),
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { GITHUB_IMPORTS } from "../github-imports";
import {
  ensureImportDocos,
  listImportDocos,
  prepareImport,
  reposUsingGitHubIssues,
} from "../github-setup.server";

const [pullRequests, issues, codebase] = GITHUB_IMPORTS;
const acme = { id: "workspace_acme", handle: "acme" };

beforeEach(async () => {
  const db = await freshDb();
  state.db = db;
  await db.exec(`
    INSERT INTO users (id, github_login, data) VALUES ('user_ana', 'ana', '{}');
    INSERT INTO workspaces (id, handle, name) VALUES
      ('workspace_acme', 'acme', 'Acme'), ('workspace_zeta', 'zeta', 'Zeta');
    INSERT INTO workspace_users (workspace_id, user_id, role) VALUES
      ('workspace_acme', 'user_ana', 'owner'), ('workspace_zeta', 'user_ana', 'owner');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data, created_at) VALUES
      ('doco_tracker', 'acme-bugs', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "bugs"}', '2026-01-01'),
      ('doco_generic', 'acme-notes', 'workspace_acme', 'workspace_acme', '{}', '2026-01-01'),
      ('doco_zeta_prs', 'zeta-prs', 'workspace_zeta', 'workspace_zeta',
        '{"template_handle": "github-pull-requests"}', '2026-01-01'),
      ('doco_zeta_issues', 'zeta-github-issues', 'workspace_zeta', 'workspace_zeta',
        '{"template_handle": "github-issues"}', '2026-01-01'),
      ('doco_zeta_issues_later', 'zeta-github-issues-2', 'workspace_zeta', 'workspace_zeta',
        '{"template_handle": "github-issues"}', '2026-02-01');
  `);
});

async function acmeDocos() {
  const r = await state.db.query<{ handle: string; template: string | null }>(
    `SELECT handle, data->>'template_handle' AS template FROM docos
      WHERE workspace_id = 'workspace_acme' ORDER BY handle`,
  );
  return r.rows;
}

describe("listImportDocos", () => {
  it("names each workspace's oldest Doco for each choice", async () => {
    expect(await listImportDocos(["workspace_acme", "workspace_zeta"])).toEqual({
      workspace_zeta: {
        "pull-requests": { id: "doco_zeta_prs", handle: "zeta-prs" },
        "github-issues": { id: "doco_zeta_issues", handle: "zeta-github-issues" },
      },
    });
  });
});

describe("ensureImportDocos", () => {
  it("creates a Doco of its own for each choice, leaving the Bug tracker alone", async () => {
    const targets = await ensureImportDocos({
      workspace: acme,
      imports: [pullRequests, issues],
      userId: "user_ana",
    });
    expect(targets.map((t) => [t.import.id, t.doco.handle])).toEqual([
      ["pull-requests", "acme-pull-requests"],
      ["github-issues", "acme-github-issues"],
    ]);
    expect(await acmeDocos()).toEqual([
      { handle: "acme-bugs", template: "bugs" },
      { handle: "acme-github-issues", template: "github-issues" },
      { handle: "acme-notes", template: null },
      { handle: "acme-pull-requests", template: "github-pull-requests" },
    ]);
  });

  it("creates nothing the second time", async () => {
    await ensureImportDocos({ workspace: acme, imports: [pullRequests], userId: "user_ana" });
    await ensureImportDocos({ workspace: acme, imports: [pullRequests], userId: "user_ana" });
    const count = await state.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM docos WHERE workspace_id = 'workspace_acme'
          AND data->>'template_handle' = 'github-pull-requests'`,
    );
    expect(count.rows[0]?.n).toBe(1);
  });
});

describe("reposUsingGitHubIssues", () => {
  it("asks GitHub through each repository's installation, a batch at a time", async () => {
    const mintToken = vi.fn(async (id: string | number) => ({ token: `t${id}`, expires_at: "" }));
    const ask = vi.fn(async (token: string, repos: string[]) =>
      token === "t1" ? new Set(repos.filter((r) => r.endsWith("-issues"))) : new Set<string>(),
    );
    const repos = Array.from({ length: 60 }, (_, i) => ({
      repo: `acme/r${i}${i === 55 ? "-issues" : ""}`,
      installation_id: 1,
    }));
    const using = await reposUsingGitHubIssues(
      [...repos, { repo: "zeta/z-issues", installation_id: 2 }],
      { mintToken: mintToken as never, reposUsingIssues: ask },
    );
    expect(using).toEqual(new Set(["acme/r55-issues"]));
    expect(ask.mock.calls.map(([token, batch]) => [token, batch.length])).toEqual([
      ["t1", 50],
      ["t1", 10],
      ["t2", 1],
    ]);
  });

  it("counts an installation GitHub won't answer for as using none", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const using = await reposUsingGitHubIssues([{ repo: "acme/app", installation_id: 1 }], {
      mintToken: vi.fn(async () => {
        throw new Error("bad key");
      }) as never,
      reposUsingIssues: vi.fn(),
    });
    expect(using).toEqual(new Set());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("prepareImport", () => {
  const picked = {
    connections: [
      { repo: "acme/app", installation_id: 1 },
      { repo: "acme/site", installation_id: 1 },
    ],
    installations: [{ installation_id: 1, account: "acme" }],
  };

  it("brings issues only from the repositories that use GitHub issues", async () => {
    const targets = await prepareImport({
      workspace: acme,
      imports: [pullRequests, issues, codebase],
      picked,
      userId: "user_ana",
      usingIssues: async () => new Set(["acme/site"]),
    });
    expect(targets.map((t) => [t.import.id, t.doco.handle, t.picked.connections])).toEqual([
      ["pull-requests", "acme-pull-requests", picked.connections],
      ["github-issues", "acme-github-issues", [{ repo: "acme/site", installation_id: 1 }]],
      ["codebase", "acme-codebase", picked.connections],
    ]);
    expect(targets[1]?.picked.installations).toEqual(picked.installations);
  });

  it("creates no issues Doco when none of the repositories use GitHub issues", async () => {
    const usingIssues = vi.fn(async () => new Set<string>());
    const targets = await prepareImport({
      workspace: acme,
      imports: [pullRequests, issues],
      picked,
      userId: "user_ana",
      usingIssues,
    });
    expect(targets.map((t) => t.import.id)).toEqual(["pull-requests"]);
    expect(usingIssues).toHaveBeenCalledWith(picked.connections);
    expect((await acmeDocos()).map((d) => d.template)).not.toContain("github-issues");
  });

  it("doesn't ask GitHub when issues aren't chosen", async () => {
    const usingIssues = vi.fn(async () => new Set<string>());
    await prepareImport({
      workspace: acme,
      imports: [codebase],
      picked,
      userId: "user_ana",
      usingIssues,
    });
    expect(usingIssues).not.toHaveBeenCalled();
  });
});
