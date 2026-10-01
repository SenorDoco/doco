// Silence alerts open when a source goes quiet for longer than its own
// history makes expected, close when it speaks again, and are emailed once to
// the owners of the Docos they concern. PGlite runs the real schema.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Email } from "../email.server";
import { checkSilences, emailNewAlerts, loadSilenceAlerts } from "../silence-alerts.server";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

type Client = Parameters<typeof checkSilences>[0];
let db: PGlite;
let c: Client;

// Wednesday 30 September 2026, 11:00 UTC.
const NOW = new Date("2026-09-30T11:00:00.000Z");
// The request context Doco records for calls through cy's Claude Code.
const CLAUDE_CODE = '{"auth": "oauth", "client_name": "Claude Code"}';

beforeEach(async () => {
  db = new PGlite({ extensions: { vector } });
  await db.exec(schemaSql);
  c = db as unknown as Client;
  await db.exec(`
    INSERT INTO users (id, github_login, email, data) VALUES
      ('user_ana', 'ana', 'ana@example.com', '{}'),
      ('user_bo', 'bo', 'bo@example.com', '{}'),
      ('user_cy', 'cy', 'cy@example.com', '{}'),
      ('user_di', 'di', NULL, '{}');
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'torre', 'Torre');
    INSERT INTO workspace_users (workspace_id, user_id, role) VALUES
      ('workspace_1', 'user_ana', 'owner'),
      ('workspace_1', 'user_di', 'owner'),
      ('workspace_1', 'user_cy', 'reader');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_slack', 'torre-slack', 'workspace_1', 'workspace_1', '{"template_handle": "slack"}'),
      ('doco_plain', 'torre-ideas', 'workspace_1', 'workspace_1', '{"template_handle": "ideas"}');
    INSERT INTO doco_users (doco_id, user_id, role) VALUES ('doco_slack', 'user_bo', 'owner');
    INSERT INTO group_chat_installations (id, provider, workspace_id, workspace_name, doco_workspace_id)
      VALUES ('gci_1', 'slack', 'T1', 'Torre', 'workspace_1');
    INSERT INTO group_chat_mirrors (doco_id, installation_id, team_domain, history_since, consented_at)
      VALUES ('doco_slack', 'gci_1', 'torre', '2026-01-01T00:00:00Z', '2026-08-01T00:00:00Z');
    INSERT INTO group_chat_channels (doco_id, channel_id, name, joined_at, excluded, archived)
      VALUES ('doco_slack', 'C_GEN', 'general', now(), false, false);
  `);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** One Slack message every working hour (09:00 to 17:00 UTC, Monday to
 *  Friday) from `from` through `to`. */
async function workdayMessages(from: string, to: string) {
  await db.query(
    `INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at)
     SELECT 'doco_slack', 'C_GEN', extract(epoch FROM h)::bigint::text || '.000100', 'hi', h
       FROM generate_series($1::timestamptz, $2::timestamptz, interval '1 hour') AS h
      WHERE extract(isodow FROM h AT TIME ZONE 'UTC') < 6
        AND extract(hour FROM h AT TIME ZONE 'UTC') BETWEEN 9 AND 17`,
    [from, to],
  );
}

async function openAlerts() {
  return (
    await db.query<{ doco_id: string; quiet_since: Date; usual: number; emailed_at: Date | null }>(
      "SELECT doco_id, quiet_since, usual, emailed_at FROM silence_alerts ORDER BY doco_id",
    )
  ).rows;
}

describe("checkSilences", () => {
  // Five weeks of messages every working hour, then nothing after Tuesday
  // 09:00. By Wednesday 11:00 every one of the past four weeks brought eleven
  // messages in the same hours, so a day of silence is unusual.
  it("opens an alert when a busy source stops in hours that always brought data", async () => {
    await workdayMessages("2026-08-24T09:00:00Z", "2026-09-29T09:00:00Z");

    expect(await checkSilences(c, NOW)).toEqual({ opened: 1, closed: 0, open: 1 });
    expect(await openAlerts()).toEqual([
      {
        doco_id: "doco_slack",
        quiet_since: new Date("2026-09-29T09:00:00Z"),
        usual: 11,
        emailed_at: null,
      },
    ]);
  });

  it("waits a full day before alerting", async () => {
    await workdayMessages("2026-08-24T09:00:00Z", "2026-09-29T17:00:00Z");
    expect(await checkSilences(c, NOW)).toEqual({ opened: 0, closed: 0, open: 0 });
  });

  // Quiet every weekend before, so quiet this weekend is expected.
  it("learns that nights and weekends are quiet", async () => {
    await workdayMessages("2026-08-24T09:00:00Z", "2026-09-25T17:00:00Z");
    expect((await checkSilences(c, new Date("2026-09-27T12:00:00Z"))).opened, "Sunday noon").toBe(
      0,
    );
    expect((await checkSilences(c, new Date("2026-09-28T11:00:00Z"))).opened, "Monday 11:00").toBe(
      0,
    );
    // By Monday afternoon the same hours always brought five or more.
    expect((await checkSilences(c, new Date("2026-09-28T14:00:00Z"))).opened, "Monday 14:00").toBe(
      1,
    );
  });

  it("stays quiet until a source has four weeks of history", async () => {
    await workdayMessages("2026-09-07T09:00:00Z", "2026-09-29T09:00:00Z");
    expect((await checkSilences(c, NOW)).opened).toBe(0);
  });

  // One message a week: a fortnight without one isn't unusual enough.
  it("doesn't alert on a source too quiet to tell", async () => {
    await db.exec(`
      INSERT INTO group_chat_messages (doco_id, channel_id, ts, text, posted_at)
      SELECT 'doco_slack', 'C_GEN', extract(epoch FROM h)::bigint::text || '.000100', 'hi', h
        FROM generate_series('2026-07-01T10:00:00Z'::timestamptz, '2026-09-16T10:00:00Z', interval '1 week') AS h;
    `);
    expect((await checkSilences(c, NOW)).opened).toBe(0);
  });

  it("keeps one alert per silence and closes it when data arrives again", async () => {
    await workdayMessages("2026-08-24T09:00:00Z", "2026-09-29T09:00:00Z");
    await checkSilences(c, NOW);
    await db.query("UPDATE silence_alerts SET emailed_at = now()");

    expect(await checkSilences(c, NOW)).toEqual({ opened: 0, closed: 0, open: 1 });
    expect((await openAlerts())[0]?.emailed_at).not.toBeNull();

    await workdayMessages("2026-09-30T10:00:00Z", "2026-09-30T10:00:00Z");
    expect(await checkSilences(c, NOW)).toEqual({ opened: 0, closed: 1, open: 0 });
    expect(await openAlerts()).toEqual([]);
  });

  it("forgets a source that was disconnected", async () => {
    await workdayMessages("2026-08-24T09:00:00Z", "2026-09-29T09:00:00Z");
    await checkSilences(c, NOW);
    await db.exec("DELETE FROM group_chat_mirrors");
    expect(await checkSilences(c, NOW)).toEqual({ opened: 0, closed: 1, open: 0 });
  });

  // A codebase's files count when they change; pull requests and bugs from
  // GitHub when Doco writes them.
  it("watches what a Doco brings from GitHub", async () => {
    await db.exec(`
      INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
        ('doco_prs', 'torre-prs', 'workspace_1', 'workspace_1',
         '{"template_handle": "github-pull-requests",
           "github_integration": {"connections": [{"repo": "torre/app", "installation_id": 7}]}}');
      INSERT INTO nodes (id, doco_id, node_type, prose, locator, created_at, updated_at)
      SELECT 'reference_' || n, 'doco_prs', 'reference', 'PR ' || n,
             'https://github.com/torre/app/pull/' || n, h, h
        FROM generate_series('2026-08-24T09:00:00Z'::timestamptz, '2026-09-29T09:00:00Z', interval '1 hour')
             WITH ORDINALITY AS g(h, n)
       WHERE extract(isodow FROM h AT TIME ZONE 'UTC') < 6
         AND extract(hour FROM h AT TIME ZONE 'UTC') BETWEEN 9 AND 17;
    `);
    await checkSilences(c, NOW);
    expect((await openAlerts()).map((a) => a.doco_id)).toEqual(["doco_prs"]);
  });
});

describe("checkSilences for agents", () => {
  beforeEach(async () => {
    await db.exec(`
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
        VALUES ('client_cc', 'Claude Code', '{http://localhost/cb}');
      INSERT INTO oauth_refresh_tokens (token, client_id, user_id, granted_doco_ids, expires_at)
        VALUES ('rt_cy', 'client_cc', 'user_cy', '{}', '2027-01-01T00:00:00Z');
    `);
  });

  /** cy's Claude Code reads torre-ideas on the even working hours and writes
   *  to it on the odd ones, from `from` through `to`. */
  async function workdayCalls(from: string, to: string) {
    const hours = `generate_series($1::timestamptz, $2::timestamptz, interval '1 hour') AS h
      WHERE extract(isodow FROM h AT TIME ZONE 'UTC') < 6
        AND extract(hour FROM h AT TIME ZONE 'UTC') BETWEEN 9 AND 17`;
    await db.query(
      `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata, at)
       SELECT 'user_cy', 'workspace_1', 'doco_plain', 'api', '${CLAUDE_CODE}', h FROM ${hours}
          AND extract(hour FROM h AT TIME ZONE 'UTC')::int % 2 = 0`,
      [from, to],
    );
    await db.query(
      `INSERT INTO changesets (doco_id, actor, source, metadata, recorded_at)
       SELECT 'doco_plain', 'user_cy', 'api', '${CLAUDE_CODE}', h FROM ${hours}
          AND extract(hour FROM h AT TIME ZONE 'UTC')::int % 2 = 1`,
      [from, to],
    );
  }

  async function agentAlerts() {
    return (
      await db.query<{ user_id: string; agent: string; doco_ids: string[]; usual: number }>(
        "SELECT user_id, agent, doco_ids, usual FROM silence_alerts WHERE agent IS NOT NULL",
      )
    ).rows;
  }

  // Reads and writes count alike, eleven in the same hours of each past week.
  it("opens an alert when an agent that read and wrote every working hour stops", async () => {
    await workdayCalls("2026-08-24T09:00:00Z", "2026-09-29T09:00:00Z");

    expect(await checkSilences(c, NOW)).toEqual({ opened: 1, closed: 0, open: 1 });
    expect(await agentAlerts()).toEqual([
      { user_id: "user_cy", agent: "Claude Code", doco_ids: ["doco_plain"], usual: 11 },
    ]);
  });

  it("closes the alert when the agent's connection is revoked", async () => {
    await workdayCalls("2026-08-24T09:00:00Z", "2026-09-29T09:00:00Z");
    await checkSilences(c, NOW);
    await db.exec("UPDATE oauth_refresh_tokens SET revoked = true");
    expect(await checkSilences(c, NOW)).toEqual({ opened: 0, closed: 1, open: 0 });
  });

  it("closes the alert when the agent's person leaves the workspace", async () => {
    await workdayCalls("2026-08-24T09:00:00Z", "2026-09-29T09:00:00Z");
    await checkSilences(c, NOW);
    await db.exec("DELETE FROM workspace_users WHERE user_id = 'user_cy'");
    expect(await checkSilences(c, NOW)).toEqual({ opened: 0, closed: 1, open: 0 });
  });

  // A person searching on the website isn't an agent.
  it("ignores what people do on the website", async () => {
    await db.query(
      `INSERT INTO query_events (actor, workspace_id, doco_id, source, metadata, at)
       SELECT 'user_cy', 'workspace_1', 'doco_plain', 'ui', '{"surface": "website"}', h
         FROM generate_series('2026-08-24T09:00:00Z'::timestamptz, '2026-09-29T09:00:00Z', interval '1 hour') AS h`,
    );
    expect(await checkSilences(c, NOW)).toEqual({ opened: 0, closed: 0, open: 0 });
  });

  it("shows the agent and the Docos it used, and emails its person and the owners", async () => {
    await workdayCalls("2026-08-24T09:00:00Z", "2026-09-29T09:00:00Z");
    await checkSilences(c, NOW);

    expect(await loadSilenceAlerts(c, ["doco_plain"])).toEqual([
      {
        id: expect.stringMatching(/^alert_/),
        kind: "agent",
        workspaceHandle: "torre",
        quietSince: "2026-09-29T09:00:00.000Z",
        usual: 11,
        agentName: "Claude Code",
        agentUser: "cy",
        docoHandles: ["torre-ideas"],
      },
    ]);

    vi.stubEnv("RESEND_API_KEY", "re_test");
    const sent: Email[] = [];
    await emailNewAlerts(c, "https://doco.to", async (email) => {
      sent.push(email);
      return { sent: true };
    });
    expect(sent.map((e) => e.to).sort()).toEqual(["ana@example.com", "cy@example.com"]);
    expect(sent[0]?.subject).toBe("Doco alert: Claude Code stopped using the torre workspace");
    expect(sent[0]?.text).toContain("https://doco.to/torre-ideas");
    expect(sent[0]?.text).toContain("https://doco.to/tokens");
  });
});

describe("loadSilenceAlerts", () => {
  it("lists the open alerts about the given Docos, as people read them", async () => {
    await workdayMessages("2026-08-24T09:00:00Z", "2026-09-29T09:00:00Z");
    await checkSilences(c, NOW);

    expect(await loadSilenceAlerts(c, ["doco_slack", "doco_plain"])).toEqual([
      {
        id: expect.stringMatching(/^alert_/),
        kind: "integration",
        workspaceHandle: "torre",
        quietSince: "2026-09-29T09:00:00.000Z",
        usual: 11,
        docoHandle: "torre-slack",
        source: "slack",
      },
    ]);
    expect(await loadSilenceAlerts(c, ["doco_plain"])).toEqual([]);
  });
});

describe("emailNewAlerts", () => {
  beforeEach(async () => {
    await workdayMessages("2026-08-24T09:00:00Z", "2026-09-29T09:00:00Z");
    await checkSilences(c, NOW);
  });

  // The workspace's owners and the Doco's own; not its readers, nor an owner
  // with no email on file.
  it("emails each owner of the Doco once", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    const sent: Email[] = [];
    const send = async (email: Email) => {
      sent.push(email);
      return { sent: true };
    };

    expect(await emailNewAlerts(c, "https://doco.to", send)).toEqual({ emailed: 1, emails: 2 });
    expect(sent.map((e) => e.to).sort()).toEqual(["ana@example.com", "bo@example.com"]);
    expect(sent[0]?.subject).toBe("Doco alert: torre-slack stopped receiving data from Slack");
    expect(sent[0]?.text).toContain(
      "torre-slack has received nothing from Slack since Sep 29, 09:00 UTC.",
    );
    expect(sent[0]?.text).toContain("about 11 updates");
    expect(sent[0]?.text).toContain("https://doco.to/torre-slack/integrations/slack");

    expect(await emailNewAlerts(c, "https://doco.to", send)).toEqual({ emailed: 0, emails: 0 });
    expect(sent).toHaveLength(2);
  });

  // Once email is set up, the alerts still open go out.
  it("holds the email while email isn't configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const send = vi.fn();
    expect(await emailNewAlerts(c, "https://doco.to", send)).toEqual({ emailed: 0, emails: 0 });
    expect(send).not.toHaveBeenCalled();
    expect((await openAlerts())[0]?.emailed_at).toBeNull();
  });
});
