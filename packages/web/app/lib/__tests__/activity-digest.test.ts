// The activity digest's schedule and message: daily during a workspace's first
// week (the previous 24 hours, saying it turns weekly from the second week),
// then weekly (the previous 7 days), with queries, writes and imports and who
// and what made the most of each, and a one-click unsubscribe.
import { describe, expect, it } from "vitest";
import { digestDue, digestEmail, digestPeriod } from "../activity-digest";
import type { ActivitySummary } from "../activity-log.server";

const DAY = 86_400_000;

describe("digestDue", () => {
  // Created on Monday Sep 7 at 15:30 UTC; digests go out at 13:00 UTC.
  const created = new Date("2026-09-07T15:30:00Z");
  const at = (day: number) => new Date(Date.UTC(2026, 8, day, 13));

  it("sends a daily digest on each of the first seven sending times after creation", () => {
    expect(digestDue(created, at(7))).toBeNull();
    for (let n = 1; n <= 7; n++) {
      expect(digestDue(created, at(7 + n))).toEqual({ kind: "daily", day: n });
    }
  });

  it("then sends a weekly digest every seventh day, starting the week after", () => {
    for (let n = 8; n <= 13; n++) expect(digestDue(created, at(7 + n))).toBeNull();
    expect(digestDue(created, at(21))).toEqual({ kind: "weekly" });
    expect(digestDue(created, at(22))).toBeNull();
    expect(digestDue(created, at(28))).toEqual({ kind: "weekly" });
  });

  it("leaves no gap: the digests cover every hour since the workspace was created", () => {
    const sends: { at: Date; since: number }[] = [];
    for (let day = 8; day <= 35; day++) {
      const due = digestDue(created, at(day));
      if (due) sends.push({ at: at(day), since: Date.parse(digestPeriod(due, at(day)).since) });
    }
    expect(sends[0].since).toBeLessThanOrEqual(created.getTime());
    for (let i = 1; i < sends.length; i++) {
      expect(sends[i].since).toBe(sends[i - 1].at.getTime());
    }
  });
});

describe("digestPeriod", () => {
  const at = new Date("2026-09-10T13:00:00Z");
  it("covers the previous 24 hours for a daily digest and 7 days for a weekly one", () => {
    expect(digestPeriod({ kind: "daily", day: 3 }, at)).toEqual({
      since: new Date(at.getTime() - DAY).toISOString(),
      until: at.toISOString(),
    });
    expect(digestPeriod({ kind: "weekly" }, at).since).toBe(
      new Date(at.getTime() - 7 * DAY).toISOString(),
    );
  });
});

describe("digestEmail", () => {
  const lastAt = "2026-09-10T12:00:00.000Z";
  const summary: ActivitySummary = {
    writes: 12,
    queries: 1340,
    imports: 2102,
    topContributors: [
      { userId: "user_ana", username: "ana", via: "Claude Code", count: 9, lastAt },
    ],
    topQueryers: [
      { userId: "user_ana", username: "ana", via: "Claude Code", count: 1300, lastAt },
      { userId: "user_bo", username: "bo", via: null, count: 40, lastAt },
    ],
    topIntegrations: [{ integration: "github", name: "GitHub", count: 2102, lastAt }],
  };
  const base = {
    baseUrl: "https://doco.test",
    workspaceHandle: "acme",
    summary,
    unsubscribeUrl: "https://doco.test/digest/unsubscribe?t=tok",
  };

  it("gives the last 24 hours' totals and tops, queries first", () => {
    const email = digestEmail({ ...base, due: { kind: "daily", day: 2 } });
    expect(email.subject).toBe("Your daily digest for acme on Doco");
    expect(email.text).toContain("Here's what happened in acme in the last 24 hours.");
    expect(email.text).toContain("1,340 queries · 12 writes · 2,102 imports");
    expect(email.text).toContain(
      "Top queryers\n- ana via Claude Code: 1,300\n- bo on the website: 40",
    );
    expect(email.text).toContain("Top contributors\n- ana via Claude Code: 9");
    expect(email.text).toContain("Top integrations\n- GitHub: 2,102");
    expect(email.text.indexOf("Top queryers")).toBeLessThan(email.text.indexOf("Top contributors"));
    expect(email.text.indexOf("Top contributors")).toBeLessThan(
      email.text.indexOf("Top integrations"),
    );
    expect(email.html).toContain("ana via Claude Code: 1,300");
    expect(email.html).toContain('href="https://doco.test/workspaces/acme"');
  });

  it("says during the first week that it turns weekly from the second week", () => {
    const email = digestEmail({ ...base, due: { kind: "daily", day: 2 } });
    const note =
      "This digest comes every day during acme's first week (day 2 of 7). From the second week on, it comes once a week and covers the previous 7 days.";
    expect(email.text).toContain(note);
    expect(email.html).toContain(note);
  });

  it("covers the last 7 days once weekly, without the first week's note", () => {
    const email = digestEmail({ ...base, due: { kind: "weekly" } });
    expect(email.subject).toBe("Your weekly digest for acme on Doco");
    expect(email.text).toContain("Here's what happened in acme in the last 7 days.");
    expect(email.text).not.toContain("first week");
  });

  it("says when a list is empty", () => {
    const email = digestEmail({
      ...base,
      due: { kind: "weekly" },
      summary: { ...summary, topIntegrations: [] },
    });
    expect(email.text).toContain("Top integrations\n- None in the last 7 days.");
  });

  it("unsubscribes in one click, from the email and from the mail client", () => {
    const email = digestEmail({ ...base, due: { kind: "weekly" } });
    expect(email.text).toContain(
      "You get this digest as a member of acme. Unsubscribe: https://doco.test/digest/unsubscribe?t=tok",
    );
    expect(email.html).toContain('href="https://doco.test/digest/unsubscribe?t=tok"');
    expect(email.headers).toEqual({
      "List-Unsubscribe": "<https://doco.test/digest/unsubscribe?t=tok>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });
});
