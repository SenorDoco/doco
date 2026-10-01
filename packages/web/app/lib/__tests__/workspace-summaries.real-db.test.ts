// The Workspaces page lists every workspace a person reaches, each with the
// icons of its Docos and the latest thing that happened in it; a workspace's
// own page shows the same summary on top. PGlite runs the real schema.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it } from "vitest";
import { loadWorkspaceSummaries } from "../workspace-summaries.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

type Client = Parameters<typeof loadWorkspaceSummaries>[0];
let db: PGlite;
let c: Client;

beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  c = db as unknown as Client;
  await db.exec(`
    INSERT INTO users (id, github_login, data) VALUES ('user_ana', 'ana', '{}'), ('user_bo', 'bo', '{}');
    INSERT INTO workspaces (id, handle, name) VALUES
      ('workspace_torre', 'torre', 'Torre'),
      ('workspace_acme', 'acme', 'Acme'),
      ('workspace_other', 'other', 'Other');
    INSERT INTO workspace_users (workspace_id, user_id, role) VALUES
      ('workspace_torre', 'user_ana', 'owner'),
      ('workspace_acme', 'user_ana', 'reader');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data, deleted_at) VALUES
      ('doco_dec', 'torre-decisions', 'workspace_torre', 'workspace_torre', '{"template_handle": "architectural-decisions"}', NULL),
      ('doco_slack', 'torre-slack', 'workspace_torre', 'workspace_torre', '{"template_handle": "slack"}', NULL),
      ('doco_gone', 'torre-gone', 'workspace_torre', 'workspace_torre', '{}', now()),
      ('doco_acme', 'acme-bugs', 'workspace_acme', 'workspace_acme', '{"template_handle": "bugs"}', NULL),
      ('doco_shared', 'other-faq', 'workspace_other', 'workspace_other', '{"template_handle": "faq"}', NULL),
      ('doco_private', 'other-ideas', 'workspace_other', 'workspace_other', '{}', NULL);
    INSERT INTO doco_users (doco_id, user_id, role) VALUES ('doco_shared', 'user_ana', 'reader');
    INSERT INTO nodes (id, doco_id, node_type, prose)
      VALUES ('decision_1', 'doco_dec', 'decision', E'Use Postgres\\nfor concurrent writes');
    INSERT INTO audit_events (event_id, at, by_user, doco_id, entity_type, entity_id, op) VALUES
      ('ev_old', '2026-09-01T00:00:00Z', 'user_bo', 'doco_dec', 'decision', 'decision_1', 'entity.update'),
      ('ev_new', '2026-09-20T00:00:00Z', 'user_bo', 'doco_dec', 'decision', 'decision_1', 'entity.create'),
      ('ev_acme', '2026-09-10T00:00:00Z', 'user_ana', 'doco_acme', 'bug', 'bug_1', 'entity.create');
  `);
});

describe("loadWorkspaceSummaries", () => {
  it("lists the reached workspaces, latest activity first, with their Docos and types", async () => {
    const summaries = await loadWorkspaceSummaries(c, "user_ana");
    expect(summaries.map((s) => s.handle)).toEqual(["torre", "acme", "other"]);
    expect(summaries[0]).toMatchObject({
      id: "workspace_torre",
      name: "Torre",
      role: "owner",
      docos: [
        { handle: "torre-decisions", template: "architectural-decisions" },
        { handle: "torre-slack", template: "slack" },
      ],
    });
  });

  it("counts what a Doco copied from its source as activity", async () => {
    await db.exec(`
      INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
        ('doco_code', 'acme-codebase', 'workspace_acme', 'workspace_acme', 'private',
          '{"template_handle": "codebase"}');
      INSERT INTO code_files (doco_id, repo, path, sha, size, synced_at) VALUES
        ('doco_code', 'acme/app', 'a.ts', 's1', 1, '2026-09-25T00:00:00Z');
    `);
    const [first] = await loadWorkspaceSummaries(c, "user_ana");
    expect(first).toMatchObject({ handle: "acme", lastActivityAt: "2026-09-25T00:00:00.000Z" });
  });

  it("says when each workspace last saw activity", async () => {
    const [torre, acme, other] = await loadWorkspaceSummaries(c, "user_ana");
    expect(torre.lastActivityAt).toBe("2026-09-20T00:00:00.000Z");
    expect(acme.lastActivityAt).toBe("2026-09-10T00:00:00.000Z");
    expect(other.lastActivityAt).toBeNull();
  });

  // A Doco invite reaches that one Doco, not its whole workspace.
  it("shows a workspace reached only through a Doco invite with just that Doco", async () => {
    const other = (await loadWorkspaceSummaries(c, "user_ana")).find((s) => s.handle === "other");
    expect(other).toMatchObject({ role: null, docos: [{ handle: "other-faq", template: "faq" }] });
  });

  it("narrows to one workspace for that workspace's page", async () => {
    const summaries = await loadWorkspaceSummaries(c, "user_ana", {
      workspaceId: "workspace_acme",
    });
    expect(summaries.map((s) => s.handle)).toEqual(["acme"]);
  });

  it("is empty for a person who reaches nothing", async () => {
    expect(await loadWorkspaceSummaries(c, "user_bo")).toEqual([]);
  });
});
