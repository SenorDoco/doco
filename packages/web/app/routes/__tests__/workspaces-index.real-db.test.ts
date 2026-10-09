// /workspaces tells the person whether they are in a project's workspace yet,
// against the real schema on PGlite. Signing up creates no workspace
// (decision_01M4GF757E9T2X902JZKYG0DKG); the personal workspace people who
// signed up before got is no project's, and is told apart by
// workspaces.personal_user_id, not by its handle.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@doco/db")>()),
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));
vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: vi.fn(async () => ({ id: "user_ana", username: "ana" })),
}));

import { loader } from "../workspaces._index";

async function inAProject(): Promise<boolean> {
  const data = await loader({ request: new Request("https://doco.test/workspaces") });
  return data.inAProject;
}

beforeEach(async () => {
  dbm.db = await freshDb();
  await dbm.db.exec(`INSERT INTO users (id, github_login, data) VALUES ('user_ana', 'ana', '{}')`);
});

describe("/workspaces loader", () => {
  it("has someone who just signed up in no project's workspace", async () => {
    expect(await inAProject()).toBe(false);
  });

  it("doesn't count the personal workspace they got at sign-up", async () => {
    await dbm.db.exec(`
      INSERT INTO workspaces (id, handle, name, personal_user_id)
        VALUES ('workspace_ana', 'ana', 'ana', 'user_ana');
      INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('workspace_ana', 'user_ana', 'owner');
    `);
    expect(await inAProject()).toBe(false);
  });

  it("counts a workspace they named after themselves", async () => {
    await dbm.db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_ana', 'ana', 'ana');
      INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('workspace_ana', 'user_ana', 'owner');
    `);
    expect(await inAProject()).toBe(true);
  });
});
