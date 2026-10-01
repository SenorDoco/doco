// "Set up..." on a Doco-level integration (GitHub, Notion) from a workspace or
// the account page opens that page with ?integration=<id>, which lists the
// Docos the person can set it up on. PGlite runs the real schema.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));
vi.mock("~/lib/slack.server", () => ({ listSlackInstallations: vi.fn() }));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { loadDocoPicker } from "../integrations-summary.server";

beforeEach(async () => {
  const db = await freshDb();
  state.db = db;
  await db.exec(`
    INSERT INTO users (id, github_login, data) VALUES ('user_ana', 'ana', '{}');
    INSERT INTO workspaces (id, handle, name) VALUES
      ('workspace_torre', 'torre', 'Torre'),
      ('workspace_acme', 'acme', 'Acme'),
      ('workspace_other', 'other', 'Other');
    INSERT INTO workspace_users (workspace_id, user_id, role) VALUES
      ('workspace_torre', 'user_ana', 'owner'),
      ('workspace_acme', 'user_ana', 'writer');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data, deleted_at) VALUES
      ('doco_dec', 'torre-decisions', 'workspace_torre', 'workspace_torre', '{}', NULL),
      ('doco_ideas', 'torre-ideas', 'workspace_torre', 'workspace_torre', '{}', NULL),
      ('doco_gone', 'torre-gone', 'workspace_torre', 'workspace_torre', '{}', now()),
      ('doco_bugs', 'acme-bugs', 'workspace_acme', 'workspace_acme', '{}', NULL),
      ('doco_private', 'other-ideas', 'workspace_other', 'workspace_other', '{}', NULL);
  `);
});

function docosByWorkspace(picker: Awaited<ReturnType<typeof loadDocoPicker>>) {
  return picker?.workspaces.map((w) => [w.handle, w.docos.map((d) => d.handle)]);
}

describe("loadDocoPicker", () => {
  it("lists every Doco the person reaches, by workspace, for Notion", async () => {
    const picker = await loadDocoPicker({ integrationId: "notion", userId: "user_ana" });
    expect(picker?.integrationId).toBe("notion");
    expect(docosByWorkspace(picker)).toEqual([
      ["acme", ["acme-bugs"]],
      ["torre", ["torre-decisions", "torre-ideas"]],
    ]);
  });

  it("narrows to one workspace on that workspace's page", async () => {
    const picker = await loadDocoPicker({
      integrationId: "notion",
      userId: "user_ana",
      workspaceId: "workspace_torre",
    });
    expect(docosByWorkspace(picker)).toEqual([["torre", ["torre-decisions", "torre-ideas"]]]);
  });

  it("is null unless the page was opened to set up a Doco-level integration without its own setup page", async () => {
    for (const integrationId of [null, "slack", "github", "nope"]) {
      expect(await loadDocoPicker({ integrationId, userId: "user_ana" })).toBeNull();
    }
  });
});
