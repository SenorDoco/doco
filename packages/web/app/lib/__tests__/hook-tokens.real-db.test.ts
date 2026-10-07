// Hook tokens against a real database: a read-only credential that reads
// one workspace as the person who made it. Made by any member, listed without
// its body (an owner sees everyone's, a member their own), revoked by its
// suffix within its workspace only, validated until revoked. The Doco hook's
// token is one per person and workspace, made the first time it is asked for.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";

const dbm = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));

const {
  hookTokenFor,
  isHookToken,
  listHookTokens,
  mintHookToken,
  hookTokenInstallHint,
  revokeHookTokenById,
  validateHookToken,
} = await import("../hook-tokens.server");

beforeEach(async () => {
  dbm.db = await freshDb();
  await dbm.db.exec(`
    INSERT INTO users (id, github_login, data) VALUES
      ('user_1', 'ann', '{}'::jsonb), ('user_2', 'bob', '{}'::jsonb);
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

describe("hook tokens", () => {
  it("mints a token for a workspace, shown whole once and listed by its suffix after", async () => {
    const minted = await mintHookToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_1",
      label: " repo bootstrap ",
    });
    expect(isHookToken(minted.full_token)).toBe(true);
    expect(minted.full_token).toMatch(/^doco_ht_[A-Za-z0-9_-]{43}$/);
    expect(minted.summary).toMatchObject({
      id: minted.full_token.slice(-8),
      preview: `doco_ht_…${minted.full_token.slice(-8)}`,
      label: "repo bootstrap",
      revoked: false,
      last_used_at: null,
      created_by_user_id: "user_1",
      created_by: "ann",
    });
    const later = await mintHookToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_1",
    });
    const listed = await listHookTokens("workspace_1", null);
    expect(listed.map((t) => t.id)).toEqual([later.summary.id, minted.summary.id]);
    expect(JSON.stringify(listed)).not.toContain(minted.full_token);
    expect(await listHookTokens("workspace_2", null)).toEqual([]);
  });

  it("lists everyone's tokens for an owner and only their own for a member", async () => {
    const ann = await mintHookToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_1",
    });
    const bob = await mintHookToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_2",
    });
    expect((await listHookTokens("workspace_1", null)).map((t) => t.created_by)).toEqual([
      "bob",
      "ann",
    ]);
    expect((await listHookTokens("workspace_1", "user_1")).map((t) => t.id)).toEqual([
      ann.summary.id,
    ]);
    expect((await listHookTokens("workspace_1", "user_2")).map((t) => t.id)).toEqual([
      bob.summary.id,
    ]);
  });

  it("lets a member revoke only their own token, and an owner anyone's", async () => {
    const ann = await mintHookToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_1",
    });
    const bob = await mintHookToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_2",
    });
    const revoke = (id: string, by: string | null) =>
      revokeHookTokenById({
        workspace_id: "workspace_1",
        token_suffix_id: id,
        created_by_user_id: by,
      });
    expect(await revoke(ann.summary.id, "user_2")).toBe(false);
    expect(await validateHookToken(ann.full_token)).not.toBeNull();
    expect(await revoke(bob.summary.id, "user_2")).toBe(true);
    expect(await revoke(ann.summary.id, null)).toBe(true);
    expect(await validateHookToken(ann.full_token)).toBeNull();
    expect(await validateHookToken(bob.full_token)).toBeNull();
  });

  // decision_01M4C2J610DPD028P55Q8X6VG2: doco_hook_token hands an agent its
  // person's token, the same one every time, so a fresh clone gets it back.
  it("makes a person's hook token the first time and returns the same one after", async () => {
    const first = await hookTokenFor({ workspace_id: "workspace_1", user_id: "user_1" });
    expect(isHookToken(first)).toBe(true);
    expect(await hookTokenFor({ workspace_id: "workspace_1", user_id: "user_1" })).toBe(first);
    const listed = await listHookTokens("workspace_1", null);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ label: "Doco hook", created_by_user_id: "user_1" });

    const bobs = await hookTokenFor({ workspace_id: "workspace_1", user_id: "user_2" });
    const annsInBeta = await hookTokenFor({ workspace_id: "workspace_2", user_id: "user_1" });
    expect(new Set([first, bobs, annsInBeta]).size).toBe(3);

    // A token made on the tokens page isn't the hook's; a revoked one is gone.
    await mintHookToken({ workspace_id: "workspace_1", created_by_user_id: "user_1" });
    expect(await hookTokenFor({ workspace_id: "workspace_1", user_id: "user_1" })).toBe(first);
    await revokeHookTokenById({
      workspace_id: "workspace_1",
      token_suffix_id: first.slice(-8),
      created_by_user_id: "user_1",
    });
    const next = await hookTokenFor({ workspace_id: "workspace_1", user_id: "user_1" });
    expect(next).not.toBe(first);
    expect(await validateHookToken(next)).toMatchObject({ created_by_user_id: "user_1" });
  });

  it("validates a token until it is revoked, within its own workspace only", async () => {
    const { full_token, summary } = await mintHookToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_1",
    });
    expect(await validateHookToken(full_token)).toMatchObject({ workspace_id: "workspace_1" });
    expect(await validateHookToken("doco_ht_unknown")).toBeNull();
    // A project token from before the rename is refused; the hook asks again.
    expect(await validateHookToken(`doco_pt_${full_token.slice(8)}`)).toBeNull();
    expect(await validateHookToken("doco_at_not_a_hook_token")).toBeNull();

    const revoke = (workspace_id: string) =>
      revokeHookTokenById({
        workspace_id,
        token_suffix_id: summary.id,
        created_by_user_id: null,
      });
    expect(await revoke("workspace_2")).toBe(false);
    expect(await validateHookToken(full_token)).toMatchObject({ workspace_id: "workspace_1" });
    expect(await revoke("workspace_1")).toBe(true);
    expect(await validateHookToken(full_token)).toBeNull();
    expect(await revoke("workspace_1")).toBe(false);
    expect((await listHookTokens("workspace_1", null))[0]?.revoked).toBe(true);
  });

  // The workspace's setup reads a used token as the person's Doco hook turned
  // on (decision_01M4C2JDN3EZMA2FR8JPPMT7NN), so the mark lands with the read.
  it("marks a token used the moment it reads", async () => {
    const { full_token } = await mintHookToken({
      workspace_id: "workspace_1",
      created_by_user_id: "user_1",
    });
    expect((await listHookTokens("workspace_1", null))[0]?.last_used_at).toBeNull();
    await validateHookToken(full_token);
    expect((await listHookTokens("workspace_1", null))[0]?.last_used_at).not.toBeNull();
  });
});

// One message, wherever a token is handed out (doco_hook_token, the hook
// tokens page, the API): what the agent does with it.
describe("hookTokenInstallHint", () => {
  const hint = hookTokenInstallHint("https://doco.test/", "acme", "doco_ht_secret");

  it("has the agent save the token in .doco/hook-tokens.json, keyed by the workspace", () => {
    expect(hint).toContain("Turn on the Doco hook in this project for the workspace acme");
    expect(hint).toContain("`.doco/hook-tokens.json`");
    expect(hint).toContain('{\n  "acme": "doco_ht_secret"\n}');
  });

  it("keeps the token out of git, since it reads as the user, and installs the hook if missing", () => {
    expect(hint).toContain("reads what the user can read in acme");
    expect(hint).toContain("add `.doco/hook-tokens.json` to `.gitignore`");
    expect(hint).not.toMatch(/commit the file/i);
    expect(hint).toContain("install it as https://doco.test/agents#hook shows");
  });
});
