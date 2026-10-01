// The GitHub setup brings each choice into the workspace's Doco for it,
// creating that Doco when the workspace has none. Every choice has a Doco of
// its own: bugs from GitHub never land in the Bug tracker people file bugs in.
// PGlite runs the real schema and the real Doco creation.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock("@doco/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@doco/db")>()),
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { GITHUB_IMPORTS } from "../github-imports";
import { ensureImportDocos, listImportDocos } from "../github-setup.server";

const [pullRequests, bugs] = GITHUB_IMPORTS;
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
      ('doco_zeta_bugs', 'zeta-github-bugs', 'workspace_zeta', 'workspace_zeta',
        '{"template_handle": "github-bugs"}', '2026-01-01'),
      ('doco_zeta_bugs_later', 'zeta-github-bugs-2', 'workspace_zeta', 'workspace_zeta',
        '{"template_handle": "github-bugs"}', '2026-02-01');
  `);
});

describe("listImportDocos", () => {
  it("names each workspace's oldest Doco for each choice", async () => {
    expect(await listImportDocos(["workspace_acme", "workspace_zeta"])).toEqual({
      workspace_zeta: {
        "pull-requests": { id: "doco_zeta_prs", handle: "zeta-prs" },
        "github-bugs": { id: "doco_zeta_bugs", handle: "zeta-github-bugs" },
      },
    });
  });
});

describe("ensureImportDocos", () => {
  it("creates a Doco of its own for each choice, leaving the Bug tracker alone", async () => {
    const targets = await ensureImportDocos({
      workspace: acme,
      imports: [pullRequests, bugs],
      userId: "user_ana",
    });
    expect(targets.map((t) => [t.import.id, t.doco.handle])).toEqual([
      ["pull-requests", "acme-pull-requests"],
      ["github-bugs", "acme-github-bugs"],
    ]);
    const created = await state.db.query<{ handle: string; template: string }>(
      `SELECT handle, data->>'template_handle' AS template FROM docos
        WHERE workspace_id = 'workspace_acme' ORDER BY handle`,
    );
    expect(created.rows).toEqual([
      { handle: "acme-bugs", template: "bugs" },
      { handle: "acme-github-bugs", template: "github-bugs" },
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
