// Creating an account (the GitHub callback's addUser) creates only the
// account: no personal workspace (decision_01M4GF757E9T2X902JZKYG0DKG), so a
// GitHub login no longer reserves a workspace handle. Real schema on PGlite.

import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", async () => {
  const actual = await vi.importActual<typeof import("@doco/db")>("@doco/db");
  return { ...actual, withClient: (fn: (c: unknown) => unknown) => fn(dbm.db) };
});

import { addUser } from "@doco/host";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";

async function workspacesOf(userId: string): Promise<string[]> {
  const r = await dbm.db.query<{ handle: string }>(
    `SELECT w.handle FROM workspaces w
       JOIN workspace_users wu ON wu.workspace_id = w.id
      WHERE wu.user_id = $1`,
    [userId],
  );
  return r.rows.map((row) => row.handle);
}

beforeEach(async () => {
  dbm.db = await freshDb();
  // Production's users table still carries the legacy kind column addUser
  // fills (see auth.dev-signin.tsx); schema.sql no longer declares it.
  await dbm.db.exec("ALTER TABLE users ADD COLUMN kind text NOT NULL");
});

describe("addUser", () => {
  it("creates the account and no workspace", async () => {
    const id = await addUser({
      username: "newcomer",
      github_identity: { github_id: "42", github_login: "Newcomer" },
    });
    const user = await dbm.db.query<{ github_login: string }>(
      "SELECT github_login FROM users WHERE id = $1",
      [id],
    );
    expect(user.rows).toEqual([{ github_login: "Newcomer" }]);
    expect(await workspacesOf(id)).toEqual([]);
    const all = await dbm.db.query("SELECT 1 FROM workspaces");
    expect(all.rows).toEqual([]);
  });

  it("signs up a login that a workspace already has as its handle", async () => {
    await dbm.db.exec(
      `INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'acme')`,
    );
    const id = await addUser({ username: "acme" });
    expect(await workspacesOf(id)).toEqual([]);
  });

  it("signs up a login that is also one of Doco's route names", async () => {
    await expect(addUser({ username: "admin" })).resolves.toMatch(/^user_/);
  });

  it("refuses a login that already has an account", async () => {
    await addUser({ username: "ana" });
    await expect(addUser({ username: "ANA" })).rejects.toThrow('Handle "ANA" is already taken.');
  });
});
