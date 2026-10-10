// Sending the activity digest, each workspace's newspaper, against a real
// database: at midnight Pacific Time every member with an email gets the
// daily edition, or on Mondays the weekly one if they switched to it, unless
// they unsubscribed (the email's links do both in one click, without signing
// in) or it is their personal workspace; two runs at the same hour send it
// once. Each leads with the stories added in its period that the member may
// read, under the workspace's masthead, or on a quiet day with a slow-news
// item. PGlite backs every
// query; only the email provider and the model are stubbed.
import { randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import type { Email } from "../email.server";

const dbm = vi.hoisted(() => ({
  db: null as unknown as InstanceType<typeof PGlite>,
  sent: [] as Email[],
  asked: 0,
}));

vi.mock("@doco/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@doco/db")>()),
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
  listDocoIdsForUser: async (userId: string) =>
    (
      await dbm.db.query<{ doco_id: string }>("SELECT doco_id FROM doco_users WHERE user_id = $1", [
        userId,
      ])
    ).rows.map((r) => r.doco_id),
}));

vi.mock("~/lib/email.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/email.server")>()),
  sendEmail: async (email: Email) => {
    dbm.sent.push(email);
    return { sent: true };
  },
}));

vi.mock("~/lib/assistant-runtime.server", () => ({
  getSenorDocoAnthropicApiKey: () => "sk-test",
  createSenorDocoMessage: async () => {
    dbm.asked += 1;
    return {
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            items: [
              { id: "idea_secret", headline: "Seat Pricing", takeaway: "Price by seat." },
              {
                id: "idea_notes",
                headline: "A Digest per Doco",
                takeaway: "Each Doco could get its own digest.",
              },
            ],
          }),
        },
      ],
    };
  },
}));

import { action, loader } from "~/routes/digest.$setting";
import { digestToken, readDigestToken, sendActivityDigests } from "../activity-digest.server";
import { readMastheadToken } from "../masthead.server";

// Thursday Sep 10, 2026, 00:00 PDT, two days after acme was created: the
// daily edition covers Wednesday.
const AT = new Date("2026-09-10T07:00:00Z");
// The Monday after, at midnight.
const MONDAY = new Date("2026-09-14T07:00:00Z");
const BASE = "https://doco.test";

beforeEach(async () => {
  vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  dbm.sent = [];
  dbm.asked = 0;
  dbm.db = await freshDb();
  await dbm.db.exec(`
    INSERT INTO users (id, github_login, email, data, deactivated_at) VALUES
      ('user_ana', 'ana', 'ana@example.com', '{}', NULL),
      ('user_bo', 'bo', 'bo@example.com', '{}', NULL),
      ('user_cy', 'cy', NULL, '{}', NULL),
      ('user_di', 'di', 'di@example.com', '{}', now());
    INSERT INTO workspaces (id, handle, name, created_at, personal_user_id) VALUES
      ('workspace_acme', 'acme', 'Acme', '2026-09-08T15:00:00Z', NULL),
      ('workspace_ana', 'ana', 'ana', '2026-09-08T15:00:00Z', 'user_ana'),
      ('workspace_old', 'old', 'Old', '2026-08-01T15:00:00Z', NULL);
    INSERT INTO workspace_users (workspace_id, user_id, role) VALUES
      ('workspace_acme', 'user_ana', 'owner'),
      ('workspace_acme', 'user_bo', 'writer'),
      ('workspace_acme', 'user_cy', 'writer'),
      ('workspace_acme', 'user_di', 'writer'),
      ('workspace_ana', 'user_ana', 'owner'),
      ('workspace_old', 'user_ana', 'owner');
    INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
      ('doco_notes', 'acme-notes', 'workspace_acme', 'workspace_acme', 'private', '{}');
  `);
  await dbm.db.query(
    `INSERT INTO changesets (doco_id, actor, source, metadata, recorded_at) VALUES
       ('doco_notes', 'user_bo', 'api', '{"auth": "oauth", "token_name": "Claude Code"}', $1),
       ('doco_notes', 'user_bo', 'api', '{"auth": "oauth", "token_name": "Claude Code"}', $2)`,
    // One on Wednesday, one the day before.
    ["2026-09-10T02:00:00Z", "2026-09-09T02:00:00Z"],
  );
  await dbm.db.query(
    `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata, at)
       VALUES ('user_ana', 'workspace_acme', NULL, 'ui', '{"surface": "website"}', $1)`,
    ["2026-09-10T03:00:00Z"],
  );
});

describe("sendActivityDigests", () => {
  it("emails each member with an email the day before's activity, every midnight", async () => {
    expect(await sendActivityDigests(dbm.db, AT, BASE)).toEqual({ workspaces: 3, sent: 3 });
    // Not cy (no email), not di (deactivated), not ana's personal workspace.
    expect(dbm.sent.map((e) => [e.to, e.subject])).toEqual([
      ["ana@example.com", "The Acme Times · Thursday, September 10, 2026"],
      ["bo@example.com", "The Acme Times · Thursday, September 10, 2026"],
      ["ana@example.com", "The Old Times · Thursday, September 10, 2026"],
    ]);
    const [ana] = dbm.sent;
    expect(ana.text).toContain("1 query · 1 write · 0 imports");
    expect(ana.text).toContain("Top queryers\n- ana on the website: 1");
    expect(ana.text).toContain("Top contributors\n- bo via Claude Code: 1");
    const link = ana.headers?.["List-Unsubscribe"]?.slice(1, -1) ?? "";
    expect(link.startsWith(`${BASE}/digest/unsubscribe?t=`)).toBe(true);
    expect(readDigestToken(new URL(link).searchParams.get("t") ?? "")).toEqual({
      workspaceId: "workspace_acme",
      userId: "user_ana",
    });
    expect(ana.text).toContain(`Switch to weekly: ${BASE}/digest/weekly?t=`);
  });

  it("comes out on a quiet day too, leading with a slow-news item", async () => {
    await sendActivityDigests(dbm.db, AT, BASE);
    const old = dbm.sent.find((e) => e.subject.startsWith("The Old Times"));
    expect(old?.text).toContain(
      `Nobody queried, wrote or imported anything in old yesterday.\nSlow news day: ${BASE}/workspaces/old`,
    );
    expect(old?.text).toContain("0 queries · 0 writes · 0 imports");
    expect(dbm.sent[0].text).not.toContain("Slow news");
  });

  it("puts the workspace's masthead at the top, one image for everyone that day", async () => {
    await sendActivityDigests(dbm.db, AT, BASE);
    const [ana, bo] = dbm.sent.map(
      (e) =>
        e.html?.match(/<img src="([^"]+)" alt="The Acme Times"/)?.[1].replaceAll("&amp;", "&") ??
        "",
    );
    expect(ana.startsWith(`${BASE}/masthead.png?t=`)).toBe(true);
    expect(bo).toBe(ana);
    expect(readMastheadToken(new URL(ana).searchParams.get("t") ?? "")).toBe("The Acme Times");
  });

  it("sends nothing at any hour but midnight Pacific Time", async () => {
    // 13:00 UTC, when the digest used to go out.
    expect(await sendActivityDigests(dbm.db, new Date("2026-09-10T13:00:00Z"), BASE)).toEqual({
      workspaces: 0,
      sent: 0,
    });
    expect(dbm.sent).toEqual([]);
    expect(await sendActivityDigests(dbm.db, AT, BASE)).toEqual({ workspaces: 3, sent: 3 });
  });

  it("leads with the stories added that day that each member may read", async () => {
    await dbm.db.exec(`
      -- A private Doco of ana's own in acme, which bo may not read.
      INSERT INTO docos (id, handle, owner_id, workspace_id, visibility, data) VALUES
        ('doco_secret', 'acme-secret', 'user_ana', 'workspace_acme', 'private', '{}');
      INSERT INTO nodes (id, doco_id, node_type, prose, created_at) VALUES
        ('rule_notes', 'doco_notes', 'rule', 'Ship every task to main.', '2026-09-10T01:00:00Z'),
        ('idea_notes', 'doco_notes', 'idea', 'A digest for each Doco.', '2026-09-10T02:00:00Z'),
        ('idea_secret', 'doco_secret', 'idea', 'Seat pricing.', '2026-09-10T02:00:00Z'),
        ('decision_notes', 'doco_notes', 'decision', 'The digest is daily.', '2026-09-10T03:00:00Z');
    `);
    await sendActivityDigests(dbm.db, AT, BASE);
    // One ranking for the workspace's daily digest, whoever gets it.
    expect(dbm.asked).toBe(1);
    const [ana, bo] = dbm.sent;
    expect(ana.text).toContain(
      [
        "Daily edition · Thursday, September 10, 2026",
        "",
        "Seat Pricing",
        "Price by seat.",
        `Idea · acme-secret: ${BASE}/acme-secret/idea/idea_secret`,
        "",
        "A Digest per Doco",
        "Each Doco could get its own digest.",
        `Idea · acme-notes: ${BASE}/acme-notes/idea/idea_notes`,
        "",
        "Ship every task to main.",
        `Rule · acme-notes: ${BASE}/acme-notes/rule/rule_notes`,
        "",
        "In brief",
        `- The digest is daily. (acme-notes: ${BASE}/acme-notes/decision/decision_notes)`,
        "",
        "Yesterday in acme",
      ].join("\n"),
    );
    expect(bo.text).toContain(
      [
        "Daily edition · Thursday, September 10, 2026",
        "",
        "A Digest per Doco",
        "Each Doco could get its own digest.",
        `Idea · acme-notes: ${BASE}/acme-notes/idea/idea_notes`,
        "",
        "Ship every task to main.",
        `Rule · acme-notes: ${BASE}/acme-notes/rule/rule_notes`,
        "",
        "The digest is daily.",
        `Decision · acme-notes: ${BASE}/acme-notes/decision/decision_notes`,
        "",
        "Yesterday in acme",
      ].join("\n"),
    );
  });

  it("sends each digest once, however many times it runs that hour", async () => {
    await sendActivityDigests(dbm.db, AT, BASE);
    expect(await sendActivityDigests(dbm.db, new Date(AT.getTime() + 60_000), BASE)).toEqual({
      workspaces: 0,
      sent: 0,
    });
    expect(dbm.sent).toHaveLength(3);
  });

  it("sends a weekly digest on Mondays, covering the last 7 days, to who switched to weekly", async () => {
    await dbm.db.exec(
      "UPDATE workspace_users SET digest = 'weekly' WHERE workspace_id = 'workspace_acme' AND user_id = 'user_bo'",
    );
    await sendActivityDigests(dbm.db, AT, BASE);
    expect(dbm.sent.map((e) => e.to)).not.toContain("bo@example.com");

    dbm.sent = [];
    await sendActivityDigests(dbm.db, MONDAY, BASE);
    const bo = dbm.sent.filter((e) => e.to === "bo@example.com");
    expect(bo.map((e) => e.subject)).toEqual(["The Acme Times · Monday, September 14, 2026"]);
    expect(bo[0].text).toContain("Weekly edition · Monday, September 14, 2026");
    expect(bo[0].text).toContain("1 query · 2 writes · 0 imports");
    expect(bo[0].text).toContain(`Switch to daily: ${BASE}/digest/daily?t=`);
    // Nothing happened on Sunday: ana's daily one is a slow-news day.
    const ana = dbm.sent.find(
      (e) => e.to === "ana@example.com" && e.subject.startsWith("The Acme"),
    );
    expect(ana?.text).toContain("Daily edition · Monday, September 14, 2026");
    expect(ana?.text).toContain("Slow news day");
  });

  it("sends the digest of a workspace someone named after themselves", async () => {
    // Only the personal workspaces people got at sign-up are marked as theirs.
    await dbm.db.exec("UPDATE workspaces SET personal_user_id = NULL WHERE id = 'workspace_ana'");
    await dbm.db.query(
      `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata, at)
         VALUES ('user_ana', 'workspace_ana', NULL, 'ui', '{"surface": "website"}', $1)`,
      ["2026-09-10T03:00:00Z"],
    );
    await sendActivityDigests(dbm.db, AT, BASE);
    expect(dbm.sent.map((e) => [e.to, e.subject])).toContainEqual([
      "ana@example.com",
      "The ana Times · Thursday, September 10, 2026",
    ]);
  });
});

describe("the digest's links", () => {
  const open = (setting: string, t: string, method = "GET") => {
    const request = new Request(`${BASE}/digest/${setting}?${new URLSearchParams({ t })}`, {
      method,
    });
    return (method === "GET" ? loader : action)({ request, params: { setting } });
  };
  const token = () => digestToken({ workspaceId: "workspace_acme", userId: "user_bo" });
  const setting = async () =>
    (
      await dbm.db.query<{ digest: string }>(
        "SELECT digest FROM workspace_users WHERE workspace_id = 'workspace_acme' AND user_id = 'user_bo'",
      )
    ).rows[0].digest;

  it("switch the digest to weekly and back to daily in one click", async () => {
    const t = token();
    expect(await open("weekly", t)).toEqual({
      state: "weekly",
      workspaceHandle: "acme",
      title: "The Acme Times",
      token: t,
    });
    expect(await setting()).toBe("weekly");
    expect(await open("daily", t)).toMatchObject({ state: "daily" });
    expect(await setting()).toBe("daily");
  });

  it("unsubscribe in one click, and subscribe again", async () => {
    expect(await open("unsubscribe", token())).toMatchObject({
      state: "off",
      workspaceHandle: "acme",
    });
    await sendActivityDigests(dbm.db, AT, BASE);
    expect(dbm.sent.map((e) => e.to)).not.toContain("bo@example.com");
    expect(await open("daily", token())).toMatchObject({ state: "daily" });
  });

  it("take a mail client's one-click POST", async () => {
    expect(await open("unsubscribe", token(), "POST")).toMatchObject({ state: "off" });
    expect(await setting()).toBe("off");
  });

  it("refuse a tampered link, say when the person left the workspace, and know no other setting", async () => {
    expect(await open("unsubscribe", "v1:nope")).toEqual({ state: "invalid" });
    await expect(open("monthly", token())).rejects.toMatchObject({ status: 404 });
    await dbm.db.query("DELETE FROM workspace_users WHERE user_id = 'user_bo'");
    expect(await open("weekly", token())).toEqual({ state: "gone" });
  });
});
