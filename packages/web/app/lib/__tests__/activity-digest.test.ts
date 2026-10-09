// The activity digest's schedule and message: every day (the previous 24
// hours) unless the member switched it to weekly (every Monday, the previous 7
// days), with queries, writes and imports and who and what made the most of
// each, a button that switches between daily and weekly, and a one-click
// unsubscribe.
import { describe, expect, it } from "vitest";
import { digestEmail, digestPeriod, settingsDue } from "../activity-digest";
import type { ActivitySummary } from "../activity-log.server";

const DAY = 86_400_000;

describe("settingsDue", () => {
  it("sends the daily digest every day and the weekly one on Mondays", () => {
    // Monday Sep 7, 2026, then the rest of that week.
    expect(settingsDue(new Date("2026-09-07T13:00:00Z"))).toEqual(["daily", "weekly"]);
    for (let day = 8; day <= 13; day++) {
      expect(settingsDue(new Date(Date.UTC(2026, 8, day, 13)))).toEqual(["daily"]);
    }
    expect(settingsDue(new Date("2026-09-14T13:00:00Z"))).toEqual(["daily", "weekly"]);
  });
});

describe("digestPeriod", () => {
  const at = new Date("2026-09-07T13:00:00Z");
  it("covers the previous 24 hours for a daily digest and 7 days for a weekly one", () => {
    expect(digestPeriod("daily", at)).toEqual({
      since: new Date(at.getTime() - DAY).toISOString(),
      until: at.toISOString(),
    });
    expect(digestPeriod("weekly", at).since).toBe(new Date(at.getTime() - 7 * DAY).toISOString());
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
    token: "tok",
  };

  it("gives the last 24 hours' totals and tops, queries first", () => {
    const email = digestEmail({ ...base, setting: "daily" });
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

  it("comes every day, with a button that switches it to weekly", () => {
    const email = digestEmail({ ...base, setting: "daily" });
    expect(email.text).toContain("Switch to weekly: https://doco.test/digest/weekly?t=tok");
    expect(email.html).toMatch(
      /<a href="https:\/\/doco.test\/digest\/weekly\?t=tok"[^>]*>Switch to weekly<\/a>/,
    );
    expect(email.text).toContain("You get this digest every day as a member of acme.");
    expect(email.text).not.toContain("first week");
  });

  it("covers the last 7 days once weekly, with a button that switches it back to daily", () => {
    const email = digestEmail({ ...base, setting: "weekly" });
    expect(email.subject).toBe("Your weekly digest for acme on Doco");
    expect(email.text).toContain("Here's what happened in acme in the last 7 days.");
    expect(email.text).toContain("Switch to daily: https://doco.test/digest/daily?t=tok");
    expect(email.html).toMatch(
      /<a href="https:\/\/doco.test\/digest\/daily\?t=tok"[^>]*>Switch to daily<\/a>/,
    );
    expect(email.text).toContain("You get this digest every Monday as a member of acme.");
  });

  it("says when a list is empty", () => {
    const email = digestEmail({
      ...base,
      setting: "weekly",
      summary: { ...summary, topIntegrations: [] },
    });
    expect(email.text).toContain("Top integrations\n- None in the last 7 days.");
  });

  for (const setting of ["daily", "weekly"] as const) {
    it(`unsubscribes in one click from the ${setting} digest and from the mail client`, () => {
      const email = digestEmail({ ...base, setting });
      expect(email.text).toContain("Unsubscribe: https://doco.test/digest/unsubscribe?t=tok");
      expect(email.html).toContain('href="https://doco.test/digest/unsubscribe?t=tok"');
      expect(email.headers).toEqual({
        "List-Unsubscribe": "<https://doco.test/digest/unsubscribe?t=tok>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      });
    });
  }
});
