// A new workspace starts with the default set of Docos, seeded from the
// real templates against in-process PGlite loaded with the real schema.

import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it, vi } from "vitest";

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

// PGlite reports `affectedRows`, not pg's `rowCount`; the host's handle
// collision check reads `rowCount`, so hand it a client that carries it.
vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const r = await dbm.db.query(sql, params);
      return { ...r, rowCount: r.rows.length };
    },
  };
  return { ...actual, withClient: (fn: (c: unknown) => unknown) => fn(client) };
});

import {
  DEFAULT_WORKSPACE_DOCO_TEMPLATES,
  addWorkspaceByHandle,
  ensurePersonalWorkspace,
} from "@doco/host";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";

const USER_ID = "user_01NEWWSDEFAULTDOCOS0000001";

interface DocoRow {
  handle: string;
  template_handle: string | null;
  goal: string;
  policy_count: number;
}

async function docosOf(workspaceId: string): Promise<DocoRow[]> {
  const r = await dbm.db.query<DocoRow>(
    `SELECT d.handle,
            d.data->>'template_handle' AS template_handle,
            d.goal,
            (SELECT count(*)::int FROM policies p WHERE p.doco_id = d.id) AS policy_count
       FROM docos d
      WHERE d.workspace_id = $1 AND d.deleted_at IS NULL
      ORDER BY d.created_at, d.id`,
    [workspaceId],
  );
  return r.rows;
}

beforeAll(async () => {
  dbm.db = await freshDb();
  await dbm.db.query("INSERT INTO users (id, github_login, data) VALUES ($1, 'newws', '{}')", [
    USER_ID,
  ]);
});

describe("addWorkspaceByHandle seeds the default Docos", () => {
  it("creates the nine default Docos, in order, from their templates", async () => {
    const ws = await addWorkspaceByHandle({ handle: "acme", ownerUserId: USER_ID });
    const docos = await docosOf(ws.id);

    expect(docos.map((d) => d.template_handle)).toEqual([
      "glossary",
      "ideas",
      "product-roadmap",
      "product-decisions",
      "design-decisions",
      "architectural-decisions",
      "process",
      "bugs",
      "agents-chats",
    ]);
    expect(docos.map((d) => d.handle)).toEqual(
      DEFAULT_WORKSPACE_DOCO_TEMPLATES.map((t) => `acme-${t}`),
    );
    for (const d of docos) {
      expect(d.goal, `${d.handle} goal`).not.toBe("");
      expect(d.policy_count, `${d.handle} policies`).toBeGreaterThan(0);
    }
  });

  it("keeps seeding when a Doco handle is already taken elsewhere", async () => {
    await dbm.db.query(
      `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data, created_at, updated_at)
       SELECT 'doco_01TAKEN00000000000000000', 'beta-glossary', id, id, 'private', '{}'::jsonb, now(), now()
         FROM workspaces WHERE handle = 'acme'`,
    );
    const ws = await addWorkspaceByHandle({ handle: "beta", ownerUserId: USER_ID });
    const handles = (await docosOf(ws.id)).map((d) => d.handle);
    expect(handles).toHaveLength(DEFAULT_WORKSPACE_DOCO_TEMPLATES.length);
    expect(handles).toContain("beta-glossary-2");
  });

  it("does not seed a personal workspace", async () => {
    const id = await ensurePersonalWorkspace(USER_ID, "newws");
    expect(await docosOf(id)).toEqual([]);
  });
});
