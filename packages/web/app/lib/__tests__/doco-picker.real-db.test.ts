// "Set up..." on a Doco-level integration (GitHub, Notion) from a workspace or
// the account page opens that page with ?integration=<id>, which lists the
// Docos the person can set it up on. PGlite runs the real schema.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("~/lib/slack.server", () => ({ listSlackInstallations: vi.fn() }));

import { loadDocoPicker } from "../integrations-summary.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

type Client = Parameters<typeof loadDocoPicker>[0];
let c: Client;

beforeEach(async () => {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  c = db as unknown as Client;
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
  it("lists every Doco the person reaches, by workspace, for GitHub and Notion", async () => {
    for (const integrationId of ["github", "notion"]) {
      const picker = await loadDocoPicker(c, { integrationId, userId: "user_ana" });
      expect(picker?.integrationId).toBe(integrationId);
      expect(docosByWorkspace(picker)).toEqual([
        ["acme", ["acme-bugs"]],
        ["torre", ["torre-decisions", "torre-ideas"]],
      ]);
    }
  });

  it("narrows to one workspace on that workspace's page", async () => {
    const picker = await loadDocoPicker(c, {
      integrationId: "github",
      userId: "user_ana",
      workspaceId: "workspace_torre",
    });
    expect(docosByWorkspace(picker)).toEqual([["torre", ["torre-decisions", "torre-ideas"]]]);
  });

  it("is null unless the page was opened to set up a Doco-level integration", async () => {
    for (const integrationId of [null, "slack", "nope"]) {
      expect(await loadDocoPicker(c, { integrationId, userId: "user_ana" })).toBeNull();
    }
  });
});
