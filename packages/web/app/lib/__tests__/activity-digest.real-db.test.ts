// Sending the activity digest against a real database: every member with an
// email gets the digest due for each workspace, except who unsubscribed (the
// email's link does it in one click, without signing in) and the owner of a
// personal workspace; two runs at the same hour send it once. PGlite backs
// every query; only the email provider is stubbed.
import { randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import type { Email } from "../email.server";

const dbm = vi.hoisted(() => ({
  db: null as unknown as InstanceType<typeof PGlite>,
  sent: [] as Email[],
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

import { action as subscribeAction, loader as subscribeLoader } from "~/routes/digest.subscribe";
import {
  action as unsubscribeAction,
  loader as unsubscribeLoader,
} from "~/routes/digest.unsubscribe";
import {
  readUnsubscribeToken,
  sendActivityDigests,
  unsubscribeToken,
} from "../activity-digest.server";

// Two days after acme was created: its second daily digest.
const AT = new Date("2026-09-10T13:00:00Z");
const BASE = "https://doco.test";

beforeEach(async () => {
  vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  dbm.sent = [];
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
    // One in the last 24 hours, one the day before.
    ["2026-09-10T09:00:00Z", "2026-09-09T09:00:00Z"],
  );
  await dbm.db.query(
    `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata, at)
       VALUES ('user_ana', 'workspace_acme', NULL, 'ui', '{"surface": "website"}', $1)`,
    ["2026-09-10T10:00:00Z"],
  );
});

describe("sendActivityDigests", () => {
  it("emails each member with an email the digest due, with the last 24 hours' activity", async () => {
    expect(await sendActivityDigests(dbm.db, AT, BASE)).toEqual({ workspaces: 2, sent: 2 });
    // Not cy (no email), not di (deactivated), not ana's personal workspace;
    // "old" is between weekly digests.
    expect(dbm.sent.map((e) => [e.to, e.subject])).toEqual([
      ["ana@example.com", "Your daily digest for acme on Doco"],
      ["bo@example.com", "Your daily digest for acme on Doco"],
    ]);
    const [ana] = dbm.sent;
    expect(ana.text).toContain("1 query · 1 write · 0 imports");
    expect(ana.text).toContain("Top queryers\n- ana on the website: 1");
    expect(ana.text).toContain("Top contributors\n- bo via Claude Code: 1");
    expect(ana.text).toContain("(day 2 of 7)");
    const link = ana.headers?.["List-Unsubscribe"]?.slice(1, -1) ?? "";
    expect(link.startsWith(`${BASE}/digest/unsubscribe?t=`)).toBe(true);
    expect(readUnsubscribeToken(new URL(link).searchParams.get("t") ?? "")).toEqual({
      workspaceId: "workspace_acme",
      userId: "user_ana",
    });
  });

  it("sends each digest once, however many times it runs that hour", async () => {
    await sendActivityDigests(dbm.db, AT, BASE);
    expect(await sendActivityDigests(dbm.db, new Date(AT.getTime() + 60_000), BASE)).toEqual({
      workspaces: 0,
      sent: 0,
    });
    expect(dbm.sent).toHaveLength(2);
  });

  it("sends the digest of a workspace someone named after themselves", async () => {
    // Only the personal workspaces people got at sign-up are marked as theirs.
    await dbm.db.exec("UPDATE workspaces SET personal_user_id = NULL WHERE id = 'workspace_ana'");
    await sendActivityDigests(dbm.db, AT, BASE);
    expect(dbm.sent.map((e) => [e.to, e.subject])).toContainEqual([
      "ana@example.com",
      "Your daily digest for ana on Doco",
    ]);
  });

  it("sends the weekly digest once the first week is over", async () => {
    // "old" was created Aug 1 at 15:00: Aug 29 13:00 is its 28th sending time.
    await sendActivityDigests(dbm.db, new Date("2026-08-29T13:00:00Z"), BASE);
    expect(dbm.sent.map((e) => [e.to, e.subject])).toEqual([
      ["ana@example.com", "Your weekly digest for old on Doco"],
    ]);
  });
});

describe("unsubscribing", () => {
  const request = (path: string, method = "GET") => new Request(`${BASE}${path}`, { method });
  const token = () => unsubscribeToken({ workspaceId: "workspace_acme", userId: "user_bo" });

  it("stops the digest in one click from the email's link, and offers to subscribe again", async () => {
    const t = new URLSearchParams({ t: token() });
    expect(await unsubscribeLoader({ request: request(`/digest/unsubscribe?${t}`) })).toEqual({
      state: "unsubscribed",
      workspaceHandle: "acme",
      token: expect.any(String),
    });
    await sendActivityDigests(dbm.db, AT, BASE);
    expect(dbm.sent.map((e) => e.to)).toEqual(["ana@example.com"]);

    await subscribeAction({ request: request(`/digest/subscribe?${t}`, "POST") });
    expect(await subscribeLoader({ request: request(`/digest/subscribe?${t}`) })).toMatchObject({
      state: "subscribed",
      workspaceHandle: "acme",
    });
  });

  it("takes a mail client's one-click POST", async () => {
    const t = new URLSearchParams({ t: token() });
    expect(
      await unsubscribeAction({ request: request(`/digest/unsubscribe?${t}`, "POST") }),
    ).toMatchObject({ state: "unsubscribed" });
    const { rows } = await dbm.db.query<{ off: boolean }>(
      "SELECT digest_unsubscribed_at IS NOT NULL AS off FROM workspace_users WHERE user_id = 'user_bo'",
    );
    expect(rows[0].off).toBe(true);
  });

  it("refuses a tampered link and says when the person left the workspace", async () => {
    expect(await unsubscribeLoader({ request: request("/digest/unsubscribe?t=v1:nope") })).toEqual({
      state: "invalid",
    });
    await dbm.db.query("DELETE FROM workspace_users WHERE user_id = 'user_bo'");
    const t = new URLSearchParams({ t: token() });
    expect(await unsubscribeLoader({ request: request(`/digest/unsubscribe?${t}`) })).toEqual({
      state: "gone",
    });
  });
});
