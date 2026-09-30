// The GitHub setup brings each choice into the workspace's Doco for it,
// creating that Doco when the workspace has none. PGlite runs the real schema
// and the real Doco creation.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock("@doco/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@doco/db")>()),
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));

import { GITHUB_IMPORTS } from "../github-imports";
import { ensureImportDocos, listImportDocos } from "../github-setup.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const [pullRequests, bugs] = GITHUB_IMPORTS;
const acme = { id: "workspace_acme", handle: "acme" };

beforeEach(async () => {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  state.db = db;
  await db.exec(`
    INSERT INTO users (id, github_login, data) VALUES ('user_ana', 'ana', '{}');
    INSERT INTO workspaces (id, handle, name) VALUES
      ('workspace_acme', 'acme', 'Acme'), ('workspace_zeta', 'zeta', 'Zeta');
    INSERT INTO workspace_users (workspace_id, user_id, role) VALUES
      ('workspace_acme', 'user_ana', 'owner'), ('workspace_zeta', 'user_ana', 'owner');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data, created_at) VALUES
      ('doco_bugs', 'acme-bugs', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "bugs"}', '2026-01-01'),
      ('doco_bugs_later', 'acme-bugs-2', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "bugs"}', '2026-02-01'),
      ('doco_generic', 'acme-notes', 'workspace_acme', 'workspace_acme', '{}', '2026-01-01'),
      ('doco_zeta_prs', 'zeta-prs', 'workspace_zeta', 'workspace_zeta',
        '{"template_handle": "github-pull-requests"}', '2026-01-01');
  `);
});

describe("listImportDocos", () => {
  it("names each workspace's oldest Doco for each choice", async () => {
    expect(await listImportDocos(["workspace_acme", "workspace_zeta"])).toEqual({
      workspace_acme: { bugs: { id: "doco_bugs", handle: "acme-bugs" } },
      workspace_zeta: { "pull-requests": { id: "doco_zeta_prs", handle: "zeta-prs" } },
    });
  });
});

describe("ensureImportDocos", () => {
  it("brings bugs into the existing Bug tracker and creates a pull requests Doco", async () => {
    const targets = await ensureImportDocos({
      workspace: acme,
      imports: [pullRequests, bugs],
      userId: "user_ana",
    });
    expect(targets.map((t) => [t.import.id, t.doco.handle])).toEqual([
      ["pull-requests", "acme-pull-requests"],
      ["bugs", "acme-bugs"],
    ]);
    const created = await state.db.query<{ template: string }>(
      `SELECT data->>'template_handle' AS template FROM docos WHERE handle = 'acme-pull-requests'`,
    );
    expect(created.rows).toEqual([{ template: "github-pull-requests" }]);
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
