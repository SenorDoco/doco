// Whoever creates a workspace walks three steps (connect GitHub, connect other
// sources or skip them, ask their agent to start using Doco); whoever joins it
// from an invite walks only the last. Members of a workspace made before the
// steps existed walk them too: its owners all three, everyone else the last.
// Each step reads as done from what the database already holds. PGlite runs
// the real schema.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { pendingStep } from "../onboarding-steps";
import {
  claimDueReminders,
  finishSourcesStep,
  loadOnboardingProgress,
  loadUnfinishedOnboarding,
  startOnboarding,
} from "../onboarding.server";

type Client = Parameters<typeof loadOnboardingProgress>[0];
let db: PGlite;
let c: Client;

const ana = { workspaceId: "workspace_acme", userId: "user_ana" };
const bo = { workspaceId: "workspace_acme", userId: "user_bo" };

beforeEach(async () => {
  db = await freshDb();
  c = db as unknown as Client;
  await db.exec(`
    INSERT INTO users (id, github_login, email, data) VALUES
      ('user_ana', 'ana', 'ana@example.com', '{}'), ('user_bo', 'bo', NULL, '{}');
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'acme');
    INSERT INTO workspace_users (workspace_id, user_id, role) VALUES
      ('workspace_acme', 'user_ana', 'owner'), ('workspace_acme', 'user_bo', 'writer');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_chats', 'acme-agents-chats', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "agents-chats"}'),
      ('doco_decisions', 'acme-product-decisions', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "product-decisions"}'),
      ('doco_prs', 'acme-pull-requests', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "github-pull-requests"}');
  `);
});

async function steps(who: { workspaceId: string; userId: string }) {
  const progress = await loadOnboardingProgress(c, who);
  return progress?.steps.map((s) => [s.step, s.done]);
}

async function agentWrites(docoId: string, userId: string, source: string) {
  await db.query("INSERT INTO changesets (doco_id, actor, source) VALUES ($1, $2, $3)", [
    docoId,
    userId,
    source,
  ]);
}

describe("onboarding steps", () => {
  it("walks the owners of a workspace made before the steps through all three", async () => {
    expect(await steps(ana)).toEqual([
      ["github", false],
      ["sources", false],
      ["agent", false],
    ]);
  });

  it("walks its other members only through asking their agent", async () => {
    expect(await steps(bo)).toEqual([["agent", false]]);
  });

  it("has no steps for someone outside the workspace, or who left it", async () => {
    await db.exec(`INSERT INTO users (id, github_login, data) VALUES ('user_cy', 'cy', '{}')`);
    expect(await loadOnboardingProgress(c, { ...ana, userId: "user_cy" })).toBeNull();
    await startOnboarding(c, { ...bo, joinedAs: "invitee" });
    await db.exec(`DELETE FROM workspace_users WHERE user_id = 'user_bo'`);
    expect(await loadOnboardingProgress(c, bo)).toBeNull();
  });

  it("never walks anyone through their personal workspace", async () => {
    await db.exec(`
      INSERT INTO workspaces (id, handle, name) VALUES ('workspace_ana', 'ana', 'ana');
      INSERT INTO workspace_users (workspace_id, user_id, role) VALUES ('workspace_ana', 'user_ana', 'owner');
    `);
    expect(
      await loadOnboardingProgress(c, { workspaceId: "workspace_ana", userId: "user_ana" }),
    ).toBeNull();
    expect([...(await loadUnfinishedOnboarding(c, "user_ana")).keys()]).toEqual(["workspace_acme"]);
  });

  it("walks the creator through GitHub, other sources and their agent, in that order", async () => {
    await startOnboarding(c, { ...ana, joinedAs: "creator" });
    expect(await steps(ana)).toEqual([
      ["github", false],
      ["sources", false],
      ["agent", false],
    ]);
  });

  it("walks an invited person only through asking their agent", async () => {
    await startOnboarding(c, { ...bo, joinedAs: "invitee" });
    expect(await steps(bo)).toEqual([["agent", false]]);
  });

  it("never restarts a creator's steps when they join again from an invite", async () => {
    await startOnboarding(c, { ...ana, joinedAs: "creator" });
    await startOnboarding(c, { ...ana, joinedAs: "invitee" });
    expect((await loadOnboardingProgress(c, ana))?.joinedAs).toBe("creator");
  });

  it("finishes GitHub once a Doco in the workspace is connected to a repository", async () => {
    await startOnboarding(c, { ...ana, joinedAs: "creator" });
    await db.exec(`
      UPDATE docos SET data = data || '{"github_integration": {"installation_authorizations":
        [{"installation_id": 7, "account": "acme"}]}}'::jsonb WHERE id = 'doco_prs';
    `);
    // Approving the App in GitHub isn't enough: nothing comes over yet.
    expect((await steps(ana))?.[0]).toEqual(["github", false]);
    await db.exec(`
      UPDATE docos SET data = jsonb_set(data, '{github_integration,connections}',
        '[{"repo": "acme/app", "installation_id": 7}]') WHERE id = 'doco_prs';
    `);
    expect((await steps(ana))?.[0]).toEqual(["github", true]);
  });

  it("finishes GitHub once a Doco subscribes to a whole organization", async () => {
    await startOnboarding(c, { ...ana, joinedAs: "creator" });
    await db.exec(`
      UPDATE docos SET data = data || '{"github_integration": {"installations":
        [{"installation_id": 7, "account": "acme"}]}}'::jsonb WHERE id = 'doco_prs';
    `);
    expect((await steps(ana))?.[0]).toEqual(["github", true]);
  });

  it("finishes the other sources once the person finishes or skips them", async () => {
    await startOnboarding(c, { ...ana, joinedAs: "creator" });
    await finishSourcesStep(c, ana);
    expect((await steps(ana))?.[1]).toEqual(["sources", true]);
  });

  it("finishes the other sources for an owner of a workspace made before the steps", async () => {
    await finishSourcesStep(c, ana);
    expect(await steps(ana)).toEqual([
      ["github", false],
      ["sources", true],
      ["agent", false],
    ]);
  });

  it("counts the other sources as done once an agent writes in the workspace", async () => {
    await startOnboarding(c, { ...ana, joinedAs: "creator" });
    await agentWrites("doco_decisions", "user_bo", "ui");
    expect((await steps(ana))?.[1]).toEqual(["sources", false]);
    await agentWrites("doco_decisions", "user_bo", "mcp");
    expect(await steps(ana)).toEqual([
      ["github", false],
      ["sources", true],
      ["agent", false],
    ]);
  });

  it("counts the other sources as done once an agent reads the workspace", async () => {
    await db.query("INSERT INTO query_events (workspace_id, actor, source) VALUES ($1, $2, $3)", [
      "workspace_acme",
      "user_bo",
      "api",
    ]);
    expect((await steps(ana))?.[1]).toEqual(["sources", true]);
  });

  it("finishes the agent step once the person's agent writes into Agents chats", async () => {
    await startOnboarding(c, { ...bo, joinedAs: "invitee" });
    await agentWrites("doco_chats", "user_bo", "mcp");
    expect(await steps(bo)).toEqual([["agent", true]]);
  });

  it("counts an agent on the API too", async () => {
    await startOnboarding(c, { ...bo, joinedAs: "invitee" });
    await agentWrites("doco_chats", "user_bo", "api");
    expect(await steps(bo)).toEqual([["agent", true]]);
  });

  it("doesn't count the person on the website, someone else's agent, or another Doco", async () => {
    await startOnboarding(c, { ...bo, joinedAs: "invitee" });
    await agentWrites("doco_chats", "user_bo", "ui");
    await agentWrites("doco_chats", "user_ana", "mcp");
    await agentWrites("doco_decisions", "user_bo", "mcp");
    expect(await steps(bo)).toEqual([["agent", false]]);
  });

  it("keeps the person on the first step not done", async () => {
    await startOnboarding(c, { ...ana, joinedAs: "creator" });
    await finishSourcesStep(c, ana);
    const progress = await loadOnboardingProgress(c, ana);
    expect(progress && pendingStep(progress)).toBe("github");
  });

  it("lists the workspaces whose steps the person hasn't finished", async () => {
    await startOnboarding(c, { ...bo, joinedAs: "invitee" });
    expect([...(await loadUnfinishedOnboarding(c, "user_bo")).keys()]).toEqual(["workspace_acme"]);
    await agentWrites("doco_chats", "user_bo", "mcp");
    expect((await loadUnfinishedOnboarding(c, "user_bo")).size).toBe(0);
  });
});

describe("claimDueReminders", () => {
  const now = new Date("2026-10-01T12:00:00Z");

  async function startedMinutesAgo(who: { workspaceId: string; userId: string }, minutes: number) {
    await db.query(
      "UPDATE workspace_onboarding SET started_at = $3 WHERE workspace_id = $1 AND user_id = $2",
      [who.workspaceId, who.userId, new Date(now.getTime() - minutes * 60_000).toISOString()],
    );
  }

  it("reminds once, 15 minutes after the start, while a step is open", async () => {
    await startOnboarding(c, { ...ana, joinedAs: "creator" });
    await startedMinutesAgo(ana, 14);
    expect(await claimDueReminders(c, now)).toEqual([]);
    await startedMinutesAgo(ana, 15);
    const [due] = await claimDueReminders(c, now);
    expect(due.email).toBe("ana@example.com");
    expect(due.progress.workspaceHandle).toBe("acme");
    expect(await claimDueReminders(c, now)).toEqual([]);
  });

  it("sends nothing once every step is done", async () => {
    await startOnboarding(c, { ...bo, joinedAs: "invitee" });
    await agentWrites("doco_chats", "user_bo", "mcp");
    await startedMinutesAgo(bo, 20);
    expect(await claimDueReminders(c, now)).toEqual([]);
  });

  it("never reminds the members of a workspace made before the steps", async () => {
    await finishSourcesStep(c, ana);
    expect(await claimDueReminders(c, new Date(now.getTime() + 60 * 60_000))).toEqual([]);
  });

  it("never sends a reminder a day late", async () => {
    await startOnboarding(c, { ...ana, joinedAs: "creator" });
    await startedMinutesAgo(ana, 24 * 60 + 1);
    expect(await claimDueReminders(c, now)).toEqual([]);
  });

  it("hands over a person without an email address so the caller can skip them", async () => {
    await startOnboarding(c, { ...bo, joinedAs: "invitee" });
    await startedMinutesAgo(bo, 30);
    const [due] = await claimDueReminders(c, now);
    expect(due.email).toBeNull();
  });
});
