// Project tokens against a real database: a committable, read-only credential
// for one workspace. Minted by an owner, listed without its body, revoked by
// its suffix within its workspace only, validated until revoked, and reading
// every live Doco of its workspace.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";

const dbm = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));

const {
  isProjectToken,
  listProjectTokens,
  mintProjectToken,
  queryProjectTokenDocos,
  revokeProjectTokenById,
  validateProjectToken,
} = await import("../project-tokens.server");

beforeEach(async () => {
  dbm.db = await freshDb();
  await dbm.db.exec(`
    INSERT INTO users (id, github_login, data) VALUES ('user_1', 'ann', '{}'::jsonb);
    INSERT INTO workspaces (id, handle, name) VALUES
      ('workspace_1', 'acme', 'Acme'), ('workspace_2', 'beta', 'Beta');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_a', 'a', 'workspace_1', 'workspace_1', '{}'::jsonb),
      ('doco_b', 'b', 'workspace_1', 'workspace_1', '{}'::jsonb),
      ('doco_gone', 'gone', 'workspace_1', 'workspace_1', '{}'::jsonb),
      ('doco_c', 'c', 'workspace_2', 'workspace_2', '{}'::jsonb);
    UPDATE docos SET deleted_at = now() WHERE id = 'doco_gone';
  `);
});

describe("project tokens", () => {
  it("mints a token for a workspace, shown whole once and listed by its suffix after", async () => {
    const minted = await mintProjectToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_1",
      label: " repo bootstrap ",
    });
    expect(isProjectToken(minted.full_token)).toBe(true);
    expect(minted.full_token).toMatch(/^doco_pt_[A-Za-z0-9_-]{43}$/);
    expect(minted.summary).toMatchObject({
      id: minted.full_token.slice(-8),
      preview: `doco_pt_…${minted.full_token.slice(-8)}`,
      label: "repo bootstrap",
      revoked: false,
      last_used_at: null,
      created_by_user_id: "user_1",
    });
    const later = await mintProjectToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_1",
    });
    const listed = await listProjectTokens("workspace_1");
    expect(listed.map((t) => t.id)).toEqual([later.summary.id, minted.summary.id]);
    expect(JSON.stringify(listed)).not.toContain(minted.full_token);
    expect(await listProjectTokens("workspace_2")).toEqual([]);
  });

  it("validates a token until it is revoked, within its own workspace only", async () => {
    const { full_token, summary } = await mintProjectToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_1",
    });
    expect(await validateProjectToken(full_token)).toMatchObject({ workspace_id: "workspace_1" });
    expect(await validateProjectToken("doco_pt_unknown")).toBeNull();
    expect(await validateProjectToken("doco_at_not_a_project_token")).toBeNull();

    expect(
      await revokeProjectTokenById({ workspace_id: "workspace_2", token_suffix_id: summary.id }),
    ).toBe(false);
    expect(await validateProjectToken(full_token)).toMatchObject({ workspace_id: "workspace_1" });
    expect(
      await revokeProjectTokenById({ workspace_id: "workspace_1", token_suffix_id: summary.id }),
    ).toBe(true);
    expect(await validateProjectToken(full_token)).toBeNull();
    expect(
      await revokeProjectTokenById({ workspace_id: "workspace_1", token_suffix_id: summary.id }),
    ).toBe(false);
    expect((await listProjectTokens("workspace_1"))[0]?.revoked).toBe(true);
  });

  it("reads every live Doco of its workspace", async () => {
    const ids = async (workspace: string) =>
      (await queryProjectTokenDocos(dbm.db, workspace)).map((d) => d.id);
    expect(await ids("workspace_1")).toEqual(["doco_a", "doco_b"]);
    expect(await ids("workspace_2")).toEqual(["doco_c"]);
    expect(await ids("workspace_none")).toEqual([]);
  });
});
