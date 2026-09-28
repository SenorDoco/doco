// Real-DB exercise of the two workspace pages that enumerate a workspace's
// Docos: the workspace home (/workspaces/:handle) and workspace search
// (/workspaces/:handle/search). Both used to list EVERY Doco in the workspace,
// so anyone who knew a workspace handle — signed out included — could read a
// private Doco's handle, its activity feed, and (via search) its node prose.
// A workspace page may only surface what the caller could open directly:
// public Docos, plus Docos the caller holds a grant on. Workspace-level content
// (the constitution) is for workspace members.
//
// PGlite backs every query; only the session, host config and embedding
// provider are stubbed.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({
  db: null as unknown as InstanceType<typeof PGlite>,
  me: null as null | { id: string },
}));

vi.mock("@doco/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@doco/db")>();
  return {
    ...original,
    withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
    getWorkspaceRole: async (workspaceId: string, userId: string) => {
      const r = await dbm.db.query<{ role: string }>(
        "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, userId],
      );
      return r.rows[0]?.role ?? null;
    },
    listDocoIdsForUser: async (userId: string) => {
      const r = await dbm.db.query<{ doco_id: string }>(
        "SELECT doco_id FROM doco_users WHERE user_id = $1",
        [userId],
      );
      return r.rows.map((row) => row.doco_id);
    },
  };
});

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: async () => dbm.me,
}));

vi.mock("~/lib/host.server", () => ({
  loadHostConfig: async () => ({ name: "Doco", visibility: "public" }),
}));

vi.mock("~/lib/embedding-provider.server", () => ({
  getDocoEmbeddingProvider: () => ({
    modelId: "test:model",
    dimensions: 3,
    embed: async () => [Float32Array.from([1, 0, 0])],
  }),
}));

const { vectorLiteral } = await import("@doco/db");
const home = await import("../workspaces.$workspaceHandle._index");
const search = await import("../workspaces.$workspaceHandle.search");

async function seed(): Promise<void> {
  const db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  dbm.db = db;
  await db.query(
    `INSERT INTO users (id, github_login, data) VALUES
       ('user_member', 'member', '{}'::jsonb),
       ('user_outsider', 'outsider', '{}'::jsonb),
       ('user_invited', 'invited', '{}'::jsonb)`,
  );
  await db.query(
    `INSERT INTO workspaces (id, handle, name, constitution) VALUES
       ('workspace_acme', 'acme', 'Acme', 'Acme internal charter'),
       ('workspace_vault', 'vault', 'Vault', 'Vault internal charter')`,
  );
  await db.query(
    `INSERT INTO workspace_users (workspace_id, user_id, role) VALUES
       ('workspace_acme', 'user_member', 'reader')`,
  );
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
       ('doco_private', 'secret-plans', 'workspace_acme', 'workspace_acme', 'private', '{}'::jsonb),
       ('doco_public', 'open-notes', 'workspace_acme', 'workspace_acme', 'public', '{}'::jsonb),
       ('doco_vault', 'vault-only', 'workspace_vault', 'workspace_vault', 'private', '{}'::jsonb)`,
  );
  await db.query(
    `INSERT INTO doco_users (doco_id, user_id, role) VALUES ('doco_private', 'user_invited', 'reader')`,
  );
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose) VALUES
       ('decision_private', 'doco_private', 'decision', 'active', 'Acquire Globex quietly'),
       ('decision_public', 'doco_public', 'decision', 'active', 'Publish the roadmap'),
       ('decision_other_model', 'doco_public', 'decision', 'active', 'Embedded by another model')`,
  );
  const vec = vectorLiteral([1, 0, 0]);
  await db.query(
    `INSERT INTO embeddings
       (doco_id, source, entity_id, chunk_index, model_id, content_hash, chunk_text, embedding)
     VALUES
       ('doco_private', 'node', 'decision_private', 0, 'test:model', 'h1', 'Acquire Globex quietly', $1::vector),
       ('doco_public', 'node', 'decision_public', 0, 'test:model', 'h2', 'Publish the roadmap', $1::vector),
       ('doco_public', 'node', 'decision_other_model', 0, 'other:model', 'h3', 'Embedded by another model', $2::vector)`,
    [vec, vectorLiteral([1, 0])],
  );
  await db.query(
    `INSERT INTO audit_events (event_id, at, by_user, doco_id, workspace_id, entity_type, entity_id, op, after_json) VALUES
       ('ev_private', now(), 'user_member', 'doco_private', 'workspace_acme', 'decision', 'decision_private', 'entity.create', '{"prose":"Acquire Globex quietly"}'::jsonb),
       ('ev_public', now(), 'user_member', 'doco_public', 'workspace_acme', 'decision', 'decision_public', 'entity.create', '{"prose":"Publish the roadmap"}'::jsonb)`,
  );
}

function as(userId: string | null): void {
  dbm.me = userId ? { id: userId } : null;
}

async function searchHits(handle: string): Promise<string[]> {
  const data = await search.loader({
    request: new Request(`https://doco.test/workspaces/${handle}/search?q=plans`),
    params: { workspaceHandle: handle },
  });
  return data.hits.map((h: { id: string }) => h.id);
}

async function homeData(handle: string) {
  return home.loader({
    request: new Request(`https://doco.test/workspaces/${handle}`),
    params: { workspaceHandle: handle },
  });
}

beforeEach(async () => {
  await seed();
});

describe("workspace search only ranks Docos the caller can read", () => {
  it("hides private Docos from a signed-out caller", async () => {
    as(null);
    expect(await searchHits("acme")).toEqual(["decision_public"]);
  });

  it("hides private Docos from a signed-in non-member", async () => {
    as("user_outsider");
    expect(await searchHits("acme")).toEqual(["decision_public"]);
  });

  it("includes private Docos for a workspace member", async () => {
    as("user_member");
    expect((await searchHits("acme")).sort()).toEqual(["decision_private", "decision_public"]);
  });

  it("includes a private Doco for someone granted that Doco directly", async () => {
    as("user_invited");
    expect((await searchHits("acme")).sort()).toEqual(["decision_private", "decision_public"]);
  });

  it("never scores vectors from a different embedding model", async () => {
    as("user_member");
    expect(await searchHits("acme")).not.toContain("decision_other_model");
  });
});

describe("workspace home only lists Docos the caller can read", () => {
  it("shows a signed-out caller only public Docos and their activity, without the constitution", async () => {
    as(null);
    const data = await homeData("acme");
    expect(data.docos.map((d: { handle: string }) => d.handle)).toEqual(["open-notes"]);
    expect(data.items.map((i: { event_id: string }) => i.event_id)).toEqual(["ev_public"]);
    expect(data.workspace.constitution).toBe("");
  });

  it("shows a member every Doco, its activity, and the constitution", async () => {
    as("user_member");
    const data = await homeData("acme");
    expect(data.docos.map((d: { handle: string }) => d.handle).sort()).toEqual([
      "open-notes",
      "secret-plans",
    ]);
    expect(data.items.map((i: { event_id: string }) => i.event_id).sort()).toEqual([
      "ev_private",
      "ev_public",
    ]);
    expect(data.workspace.constitution).toBe("Acme internal charter");
  });

  it("404s a workspace where the caller can read nothing", async () => {
    as("user_outsider");
    await expect(homeData("vault")).rejects.toMatchObject({ status: 404 });
  });
});
