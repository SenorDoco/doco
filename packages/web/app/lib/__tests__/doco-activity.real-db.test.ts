// A Doco's activity, as its home's side column shows it: its writes, queries
// and imports each day, the latest recorded writes, and who wrote to it, who
// queried it and what imported into it most in the last 7 days. PGlite runs
// the real schema.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { loadDocoActivity } from "../doco-activity.server";

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
  db = await freshDb();
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
  await db.query(
    `INSERT INTO changesets (doco_id, actor, source, metadata, recorded_at)
       VALUES ('doco_notion', 'user_ana', 'api', '{"auth": "oauth", "token_name": "Claude Code"}', $1)`,
    [daysAgo(3)],
  );
  await db.query(
    `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata, at)
       VALUES ('user_ana', 'workspace_1', 'doco_notion', 'ui', '{"surface": "website"}', $1)`,
    [daysAgo(1)],
  );
});

describe("loadDocoActivity", () => {
  it("counts each day's writes, queries and imports, and lists the latest writes and the last week's tops", async () => {
    const activity = await loadDocoActivity(db as never, "doco_notion");
    expect(activity.byDay).toEqual({
      writes: { [day(daysAgo(3))]: 1 },
      queries: { [day(daysAgo(1))]: 1 },
      imports: { [day(daysAgo(3))]: 2, [day(daysAgo(10))]: 1 },
    });
    // Policy writes are the Doco's settings, not its activity.
    expect(activity.items.map((it) => [it.id, it.summary, it.op])).toEqual([
      ["decision_1", "Keep the handbook in Notion", "entity.create"],
    ]);
    const week = activity.lastWeek;
    expect(week.topContributors.map((a) => [a.username, a.via, a.count])).toEqual([
      ["ana", "Claude Code", 1],
    ]);
    expect(week.topQueryers.map((a) => [a.username, a.via, a.count])).toEqual([["ana", null, 1]]);
    // The page edited 10 days ago is older than the last 7 days.
    expect(week.topIntegrations.map((i) => [i.name, i.count])).toEqual([["Notion", 2]]);
  });
});
