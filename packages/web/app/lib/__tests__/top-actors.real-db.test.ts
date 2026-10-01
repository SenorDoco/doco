// Real-database exercise of the Top contributors and Top queryers lists. Each
// row is a person and the agent they worked through (or the website), so one
// person can appear once per agent. Writes come from `changesets`, queries from
// `query_events`; both carry the same request context.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it } from "vitest";
import { listTopActors } from "../top-actors.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

let db: InstanceType<typeof PGlite>;

const CLAUDE_CODE = { auth: "oauth", token_name: "Claude Code", client_name: "claude-code" };
const WEBSITE = { surface: "website" };

async function write(
  actor: string | null,
  docoId: string,
  source: string,
  metadata: Record<string, unknown> | null,
  at: string,
) {
  await db.query(
    "INSERT INTO changesets (doco_id, actor, source, metadata, recorded_at) VALUES ($1, $2, $3, $4, $5)",
    [docoId, actor, source, metadata ? JSON.stringify(metadata) : null, at],
  );
}

async function query(
  actor: string | null,
  docoId: string | null,
  source: string,
  metadata: Record<string, unknown> | null,
  at: string,
) {
  await db.query(
    `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata, at)
     VALUES ($1, 'workspace_acme', $2, $3, $4, $5)`,
    [actor, docoId, source, metadata ? JSON.stringify(metadata) : null, at],
  );
}

beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  await db.query(
    `INSERT INTO users (id, github_login, data) VALUES
       ('user_alice', 'alice', '{}'::jsonb),
       ('user_bob', 'bob', '{}'::jsonb)`,
  );
  await db.query(
    "INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme')",
  );
  await db.query(
    `INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
       ('doco_notes', 'acme-notes', 'workspace_acme', 'workspace_acme', '{}'::jsonb),
       ('doco_bugs', 'acme-bugs', 'workspace_acme', 'workspace_acme', '{}'::jsonb)`,
  );
});

describe("listTopActors writes", () => {
  it("lists each person once per agent, with the website marked", async () => {
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-02T10:00:00Z");
    await write("user_alice", "doco_bugs", "api", CLAUDE_CODE, "2026-09-03T10:00:00Z");
    await write("user_alice", "doco_notes", "ui", WEBSITE, "2026-09-04T10:00:00Z");
    await write("user_bob", "doco_notes", "api", null, "2026-09-05T10:00:00Z");
    await write("user_bob", "doco_notes", "api", null, "2026-09-06T10:00:00Z");
    // A project token has no person behind it.
    await write(null, "doco_notes", "api", { auth: "bearer" }, "2026-09-07T10:00:00Z");

    const actors = await listTopActors(db, "writes", { docoIds: ["doco_notes", "doco_bugs"] }, 10);
    expect(actors).toEqual([
      {
        userId: "user_alice",
        username: "alice",
        via: "Claude Code",
        count: 3,
        lastAt: "2026-09-03T10:00:00.000Z",
      },
      {
        userId: "user_bob",
        username: "bob",
        via: "Import",
        count: 2,
        lastAt: "2026-09-06T10:00:00.000Z",
      },
      {
        userId: "user_alice",
        username: "alice",
        via: null,
        count: 1,
        lastAt: "2026-09-04T10:00:00.000Z",
      },
    ]);
  });

  it("merges credentials that carry the same agent name", async () => {
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await write(
      "user_alice",
      "doco_notes",
      "api",
      { auth: "oauth", token_name: "Claude Code", client_name: "claude-code-laptop" },
      "2026-09-02T10:00:00Z",
    );
    const actors = await listTopActors(db, "writes", { docoIds: ["doco_notes"] }, 10);
    expect(actors).toEqual([
      {
        userId: "user_alice",
        username: "alice",
        via: "Claude Code",
        count: 2,
        lastAt: "2026-09-02T10:00:00.000Z",
      },
    ]);
  });

  it("keeps to the Docos asked for and the limit", async () => {
    await write("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await write("user_bob", "doco_bugs", "ui", WEBSITE, "2026-09-02T10:00:00Z");
    await write("user_bob", "doco_bugs", "ui", WEBSITE, "2026-09-03T10:00:00Z");
    expect(
      (await listTopActors(db, "writes", { docoIds: ["doco_notes"] }, 10)).map((a) => a.username),
    ).toEqual(["alice"]);
    expect(
      (await listTopActors(db, "writes", { docoIds: ["doco_notes", "doco_bugs"] }, 1)).map(
        (a) => a.username,
      ),
    ).toEqual(["bob"]);
  });
});

describe("listTopActors queries", () => {
  it("counts a workspace's searches only on the workspace", async () => {
    await query("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-01T10:00:00Z");
    await query("user_alice", "doco_notes", "api", CLAUDE_CODE, "2026-09-02T10:00:00Z");
    await query("user_alice", null, "ui", WEBSITE, "2026-09-03T10:00:00Z");
    await query(
      "user_bob",
      "doco_bugs",
      "ui",
      { surface: "senor_doco", client: "website" },
      "2026-09-04T10:00:00Z",
    );

    expect(
      await listTopActors(
        db,
        "queries",
        { docoIds: ["doco_notes", "doco_bugs"], workspaceId: "workspace_acme" },
        10,
      ),
    ).toEqual([
      {
        userId: "user_alice",
        username: "alice",
        via: "Claude Code",
        count: 2,
        lastAt: "2026-09-02T10:00:00.000Z",
      },
      {
        userId: "user_bob",
        username: "bob",
        via: "Señor Doco on website",
        count: 1,
        lastAt: "2026-09-04T10:00:00.000Z",
      },
      {
        userId: "user_alice",
        username: "alice",
        via: null,
        count: 1,
        lastAt: "2026-09-03T10:00:00.000Z",
      },
    ]);

    expect(await listTopActors(db, "queries", { docoIds: ["doco_notes"] }, 10)).toEqual([
      {
        userId: "user_alice",
        username: "alice",
        via: "Claude Code",
        count: 2,
        lastAt: "2026-09-02T10:00:00.000Z",
      },
    ]);
  });
});
