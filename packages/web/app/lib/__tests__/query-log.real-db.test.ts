// Real-database exercise of the query log: a query lands in `query_events`
// with the same request context a write's changeset records, so the agent a
// person queried through is named the same way as the one they wrote through.

import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));

vi.mock("../oauth-server.server", () => ({
  validateAccessToken: async (token: string) =>
    token === "doco_at_claude_code"
      ? { token_name: "Claude Code", client_name: "claude-code" }
      : null,
}));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { recordQuery } from "../query-log.server";

async function rows() {
  return (
    await dbm.db.query<{
      actor: string | null;
      workspace_id: string;
      doco_id: string | null;
      source: string;
      metadata: Record<string, unknown> | null;
    }>("SELECT actor, workspace_id, doco_id, source, metadata FROM query_events ORDER BY id")
  ).rows;
}

beforeEach(async () => {
  dbm.db = await freshDb();
  await dbm.db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme')",
  );
  await dbm.db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, data)
     VALUES ('doco_notes', 'acme-notes', 'workspace_acme', 'workspace_acme', '{}'::jsonb)`,
  );
});

describe("recordQuery", () => {
  it("records an agent's query with the token it used", async () => {
    const request = new Request("https://doco.test/acme-notes/search.json?q=pricing", {
      headers: { authorization: "Bearer doco_at_claude_code" },
    });
    await recordQuery(
      request,
      { workspaceId: "workspace_acme", docoId: "doco_notes" },
      "user_alice",
    );
    expect(await rows()).toEqual([
      {
        actor: "user_alice",
        workspace_id: "workspace_acme",
        doco_id: "doco_notes",
        source: "api",
        metadata: { auth: "oauth", token_name: "Claude Code", client_name: "claude-code" },
      },
    ]);
  });

  it("records a search on the website as the website", async () => {
    const request = new Request("https://doco.test/workspaces/acme/search?q=pricing");
    await recordQuery(request, { workspaceId: "workspace_acme", docoId: null }, "user_alice");
    expect(await rows()).toEqual([
      {
        actor: "user_alice",
        workspace_id: "workspace_acme",
        doco_id: null,
        source: "ui",
        metadata: { surface: "website" },
      },
    ]);
  });

  it("records Señor Doco's reads as Señor Doco", async () => {
    const request = new Request("https://doco.test/acme-notes/search.json?q=pricing", {
      headers: { "x-doco-authoring-surface": "senor-doco-web" },
    });
    await recordQuery(
      request,
      { workspaceId: "workspace_acme", docoId: "doco_notes" },
      "user_alice",
    );
    expect((await rows())[0]).toMatchObject({
      source: "ui",
      metadata: { surface: "senor_doco", client: "website" },
    });
  });

  it("never fails the read it records", async () => {
    const request = new Request("https://doco.test/acme-notes/search.json?q=pricing");
    await expect(
      recordQuery(request, { workspaceId: "workspace_missing", docoId: null }, "user_alice"),
    ).resolves.toBeUndefined();
    expect(await rows()).toEqual([]);
  });
});
