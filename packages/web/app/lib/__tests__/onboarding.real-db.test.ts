// The dashboard walks a person through three steps: create a workspace,
// connect an agent, connect sources of knowledge. Each step reads as done from
// what the database already holds. PGlite runs the real schema.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it } from "vitest";
import { loadOnboardingProgress } from "../onboarding.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

type Client = Parameters<typeof loadOnboardingProgress>[0];
let db: PGlite;
let c: Client;

beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  c = db as unknown as Client;
  await db.exec(`
    INSERT INTO users (id, github_login, data) VALUES ('user_ana', 'ana', '{}'), ('user_bo', 'bo', '{}');
  `);
});

async function joinWorkspace(userId: string) {
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'torre', 'Torre')
      ON CONFLICT DO NOTHING;
    INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('workspace_1', '${userId}', 'owner');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data)
      VALUES ('doco_1', 'torre-decisions', 'workspace_1', 'workspace_1', '{}'::jsonb)
      ON CONFLICT DO NOTHING;
  `);
}

async function connectAgent(userId: string, opts: { revoked?: boolean } = {}) {
  await db.exec(`
    INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
      VALUES ('client_1', 'Claude', ARRAY['https://claude.ai/cb']) ON CONFLICT DO NOTHING;
    INSERT INTO oauth_refresh_tokens (token, client_id, user_id, granted_doco_ids, grant_type, expires_at, revoked)
      VALUES ('rt_${userId}', 'client_1', '${userId}', ARRAY[]::text[], 'actor', now() + interval '30 days', ${opts.revoked ? "true" : "false"});
  `);
}

describe("loadOnboardingProgress", () => {
  it("has every step open for a brand-new person", async () => {
    expect(await loadOnboardingProgress(c, "user_ana")).toEqual({
      workspace: false,
      agent: false,
      sources: false,
    });
  });

  it("marks the workspace step done once the person belongs to a workspace", async () => {
    await joinWorkspace("user_ana");
    expect(await loadOnboardingProgress(c, "user_ana")).toMatchObject({ workspace: true });
    expect(await loadOnboardingProgress(c, "user_bo")).toMatchObject({ workspace: false });
  });

  // Every person gets a personal workspace named after them at sign-up. It is
  // not a project's workspace, so it does not finish the first step.
  it("does not count the personal workspace every person gets at sign-up", async () => {
    await db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_ana', 'ana', 'ana');
      INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('workspace_ana', 'user_ana', 'owner');
    `);
    expect(await loadOnboardingProgress(c, "user_ana")).toMatchObject({ workspace: false });
  });

  // Someone invited straight to a Doco has joined a project too.
  it("marks the workspace step done once the person is invited to a Doco", async () => {
    await db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'torre', 'Torre');
      INSERT INTO docos (id, handle, owner_id, workspace_id, data)
        VALUES ('doco_1', 'torre-decisions', 'workspace_1', 'workspace_1', '{}'::jsonb);
      INSERT INTO doco_users (doco_id, user_id, role) VALUES ('doco_1', 'user_bo', 'reader');
    `);
    expect(await loadOnboardingProgress(c, "user_bo")).toMatchObject({ workspace: true });
  });

  it("marks the agent step done once the person has connected an agent", async () => {
    await connectAgent("user_ana");
    expect(await loadOnboardingProgress(c, "user_ana")).toMatchObject({ agent: true });
    expect(await loadOnboardingProgress(c, "user_bo")).toMatchObject({ agent: false });
  });

  it("does not count a revoked connection", async () => {
    await connectAgent("user_ana", { revoked: true });
    expect(await loadOnboardingProgress(c, "user_ana")).toMatchObject({ agent: false });
  });

  it("marks the sources step done once a workspace Doco copies from GitHub", async () => {
    await joinWorkspace("user_ana");
    await db.exec(`
      UPDATE docos SET data = '{"github_integration": {"repo": "torre/app"}}'::jsonb WHERE id = 'doco_1';
    `);
    expect(await loadOnboardingProgress(c, "user_ana")).toMatchObject({ sources: true });
    expect(await loadOnboardingProgress(c, "user_bo")).toMatchObject({ sources: false });
  });

  it("marks the sources step done once a Slack team is bound to the workspace", async () => {
    await joinWorkspace("user_ana");
    await db.exec(`
      INSERT INTO group_chat_installations (id, provider, workspace_id, workspace_name, doco_workspace_id)
        VALUES ('gci_1', 'slack', 'T1', 'Torre', 'workspace_1');
    `);
    expect(await loadOnboardingProgress(c, "user_ana")).toMatchObject({ sources: true });
  });

  it("marks the sources step done once a workspace Doco mirrors Notion", async () => {
    await joinWorkspace("user_ana");
    await db.exec(`
      INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
        VALUES ('doco_1', 'ws-1', 'Torre', 'bot-1', 'v1:enc', now());
    `);
    expect(await loadOnboardingProgress(c, "user_ana")).toMatchObject({ sources: true });
  });
});
