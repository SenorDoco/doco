// A Doco's activity, as its home's side column shows it: how much happened
// each day (nodes captured and what it copied from its source), the latest
// recorded writes, and who made them. PGlite runs the real schema.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { beforeEach, describe, expect, it } from "vitest";
import { loadDocoActivity } from "../doco-activity.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

let db: PGlite;

/** Midday, `n` days ago, so every row sits inside the year the chart covers. */
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
};
const day = (iso: string) => iso.slice(0, 10);

beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  await db.exec(
    `INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'torre', 'Torre');
     INSERT INTO users (id, github_login, data) VALUES ('user_ana', 'ana', '{}');
     INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
       ('doco_notion', 'torre-notion', 'workspace_1', 'workspace_1', 'private', '{"template_handle": "notion"}');
     INSERT INTO notion_mirrors (doco_id, workspace_id, workspace_name, bot_id, access_token, consented_at)
       VALUES ('doco_notion', 'ws-1', 'Torre', 'bot-1', 'v1:enc', now());`,
  );
  await db.query(
    `INSERT INTO notion_pages (doco_id, page_id, object, url, last_edited_time, synced_at) VALUES
       ('doco_notion', 'p1', 'page', 'https://www.notion.so/p1', $1, now()),
       ('doco_notion', 'p2', 'page', 'https://www.notion.so/p2', $1, now()),
       ('doco_notion', 'p3', 'page', 'https://www.notion.so/p3', $2, now())`,
    [daysAgo(3), daysAgo(10)],
  );
  await db.query(
    `INSERT INTO nodes (id, doco_id, node_type, lifecycle, prose, created_at)
       VALUES ('decision_1', 'doco_notion', 'decision', 'active', 'Keep the handbook in Notion', $1)`,
    [daysAgo(3)],
  );
  await db.query(
    `INSERT INTO audit_events (event_id, at, by_user, doco_id, entity_type, entity_id, op, after_json) VALUES
       ('ev_1', $1, 'user_ana', 'doco_notion', 'decision', 'decision_1', 'entity.create',
        '{"decision": "Keep the handbook in Notion"}'),
       ('ev_2', $2, 'user_ana', 'doco_notion', 'policy', 'policy_1', 'entity.create', '{}')`,
    [daysAgo(3), daysAgo(2)],
  );
});

describe("loadDocoActivity", () => {
  it("counts each day's copies and captures, and lists the latest writes and who made them", async () => {
    const activity = await loadDocoActivity(db as never, "doco_notion");
    expect(activity.byDay).toEqual({ [day(daysAgo(3))]: 3, [day(daysAgo(10))]: 1 });
    // Policy writes are the Doco's settings, not its activity.
    expect(activity.items.map((it) => [it.id, it.summary, it.op])).toEqual([
      ["decision_1", "Keep the handbook in Notion", "entity.create"],
    ]);
    expect(activity.topContributors.map((c) => [c.username, c.eventCount])).toEqual([["ana", 1]]);
  });
});
