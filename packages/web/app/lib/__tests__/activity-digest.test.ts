// The activity digest is each workspace's newspaper, The <Workspace> Times:
// every day at midnight Pacific Time, covering the day before (or, for who
// switched to weekly, every Monday, covering the week before), laid out as a
// front page under its masthead. It leads with the most important records
// added in it, or on a quiet day with a slow-news item, then queries, writes
// and imports and who and what made the most of each, a button that switches
// between daily and weekly, and a one-click unsubscribe.
import { describe, expect, it } from "vitest";
import {
  SLOW_NEWS,
  type Story,
  digestEmail,
  digestPeriod,
  editionDate,
  settingsDue,
  timesTitle,
} from "../activity-digest";
import type { ActivitySummary } from "../activity-log.server";

describe("settingsDue", () => {
  it("sends the daily edition at midnight Pacific Time, and on Mondays the weekly one", () => {
    // Monday Sep 7, 2026, 00:00 PDT, then the rest of that week.
    expect(settingsDue(new Date("2026-09-07T07:00:00Z"))).toEqual(["daily", "weekly"]);
    for (let day = 8; day <= 13; day++) {
      expect(settingsDue(new Date(Date.UTC(2026, 8, day, 7)))).toEqual(["daily"]);
    }
    expect(settingsDue(new Date("2026-09-14T07:00:00Z"))).toEqual(["daily", "weekly"]);
  });

  it("follows daylight saving time, and sends nothing at any other hour", () => {
    // 01:00 PDT, and 13:00 UTC, when the digest used to go out.
    expect(settingsDue(new Date("2026-09-07T08:00:00Z"))).toEqual([]);
    expect(settingsDue(new Date("2026-09-07T13:00:00Z"))).toEqual([]);
    // Monday Dec 7, 2026, 00:00 PST, and the hour before it.
    expect(settingsDue(new Date("2026-12-07T08:00:00Z"))).toEqual(["daily", "weekly"]);
    expect(settingsDue(new Date("2026-12-07T07:00:00Z"))).toEqual([]);
  });
});

describe("digestPeriod", () => {
  it("covers the day before for a daily edition and the week before for a weekly one", () => {
    const at = new Date("2026-09-07T07:00:00Z");
    expect(digestPeriod("daily", at)).toEqual({
      since: "2026-09-06T07:00:00.000Z",
      until: "2026-09-07T07:00:00.000Z",
    });
    expect(digestPeriod("weekly", at).since).toBe("2026-08-31T07:00:00.000Z");
  });

  it("starts at the midnight before, when daylight saving time began or ended in between", () => {
    // Daylight saving time ended on Sunday Nov 1, 2026: a day of 25 hours.
    const monday = new Date("2026-11-02T08:00:00Z");
    expect(digestPeriod("daily", monday).since).toBe("2026-11-01T07:00:00.000Z");
    expect(digestPeriod("weekly", monday).since).toBe("2026-10-26T07:00:00.000Z");
    // It began on Sunday Mar 8, 2026: a day of 23 hours.
    expect(digestPeriod("daily", new Date("2026-03-09T07:00:00Z")).since).toBe(
      "2026-03-08T08:00:00.000Z",
    );
  });
});

describe("editionDate", () => {
  it("dates the edition the day it comes out in Pacific Time", () => {
    expect(editionDate(new Date("2026-09-07T07:00:00Z"))).toBe("Monday, September 7, 2026");
  });
});

describe("timesTitle", () => {
  it("names the newspaper after the workspace, without a second The", () => {
    expect(timesTitle("Acme")).toBe("The Acme Times");
    expect(timesTitle(" The Agency ")).toBe("The Agency Times");
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
    title: "The Acme Times",
    masthead: "https://doco.test/masthead.png?t=seal",
    at: new Date("2026-09-07T07:00:00Z"),
    summary,
    stories: [],
    token: "tok",
  };
  const story = (n: number, over: Partial<Story> = {}): Story => ({
    id: `decision_${n}`,
    docoId: "doco_notes",
    docoHandle: "acme-notes",
    nodeType: "decision",
    headline: `Headline ${n}`,
    takeaway: `Takeaway ${n}.`,
    url: `https://doco.test/acme-notes/decision/decision_${n}`,
    ...over,
  });
  const stories = [
    story(1, {
      id: "rule_1",
      nodeType: "rule",
      headline: "Every Task Ships to <Main>",
      takeaway: "Every task ships to main.",
      url: "https://doco.test/acme-notes/rule/rule_1",
    }),
    ...[2, 3, 4, 5].map((n) => story(n)),
  ];

  it("is The <Workspace> Times of the day, under its masthead and dateline", () => {
    const email = digestEmail({ ...base, setting: "daily" });
    expect(email.subject).toBe("The Acme Times · Monday, September 7, 2026");
    expect(
      email.text.startsWith("The Acme Times\nDaily edition · Monday, September 7, 2026\n\n"),
    ).toBe(true);
    const html = email.html ?? "";
    expect(html).toMatch(
      /<img src="https:\/\/doco.test\/masthead.png\?t=seal" alt="The Acme Times" width="544"/,
    );
    expect(html.indexOf("masthead.png")).toBeLessThan(html.indexOf("Daily edition"));
    expect(html.indexOf("Daily edition")).toBeLessThan(html.indexOf("Monday, September 7, 2026"));
    expect(digestEmail({ ...base, setting: "weekly" }).text).toContain(
      "Weekly edition · Monday, September 7, 2026",
    );
  });

  it("leads with the most important story, two more beside it, and the rest in brief", () => {
    const email = digestEmail({ ...base, setting: "daily", stories });
    expect(email.text).toContain(
      [
        "Daily edition · Monday, September 7, 2026",
        "",
        "Every Task Ships to <Main>",
        "Every task ships to main.",
        "Rule · acme-notes: https://doco.test/acme-notes/rule/rule_1",
        "",
        "Headline 2",
        "Takeaway 2.",
        "Decision · acme-notes: https://doco.test/acme-notes/decision/decision_2",
        "",
        "Headline 3",
        "Takeaway 3.",
        "Decision · acme-notes: https://doco.test/acme-notes/decision/decision_3",
        "",
        "In brief",
        "- Headline 4 (acme-notes: https://doco.test/acme-notes/decision/decision_4)",
        "- Headline 5 (acme-notes: https://doco.test/acme-notes/decision/decision_5)",
        "",
        "Yesterday in acme",
      ].join("\n"),
    );
    const html = email.html ?? "";
    // The lead's headline is the biggest, linked to its record, and escaped.
    expect(html).toMatch(
      /font-size:26px[^>]*><a href="https:\/\/doco.test\/acme-notes\/rule\/rule_1"[^>]*>Every Task Ships to &lt;Main&gt;<\/a>/,
    );
    expect(html).toContain(">Rule · acme-notes</p>");
    const at = (s: string) => html.indexOf(s);
    expect(at("Every Task Ships")).toBeLessThan(at("Headline 2"));
    expect(at("Headline 2")).toBeLessThan(at("Headline 3"));
    expect(at("Headline 3")).toBeLessThan(at("In brief"));
    expect(at("In brief")).toBeLessThan(at("Headline 4"));
    expect(at("Headline 5")).toBeLessThan(at("Yesterday in acme"));
    // The two after the lead share a row.
    expect(html.slice(at("Headline 2"), at("Headline 3"))).toContain("display:inline-block");
  });

  it("prints a story without its takeaway when it has none", () => {
    const email = digestEmail({ ...base, setting: "daily", stories: [story(1, { takeaway: "" })] });
    expect(email.text).toContain(
      "Headline 1\nDecision · acme-notes: https://doco.test/acme-notes/decision/decision_1\n\n",
    );
  });

  it("leaves the stories out when nothing was added", () => {
    const email = digestEmail({ ...base, setting: "daily" });
    expect(email.text).toContain(
      "Daily edition · Monday, September 7, 2026\n\nYesterday in acme\n",
    );
    expect(email.html).not.toContain("In brief");
    expect(email.text).not.toContain("Slow news");
  });

  // Alexander, 2026-10-10: the paper comes out even when nothing happened,
  // and then leads with something funny instead.
  const quiet = {
    ...summary,
    writes: 0,
    queries: 0,
    imports: 0,
    topContributors: [],
    topQueryers: [],
    topIntegrations: [],
  };

  it("leads a quiet day's paper with a slow-news item", () => {
    const email = digestEmail({ ...base, setting: "daily", summary: quiet });
    const headline = SLOW_NEWS[Math.floor(base.at.getTime() / 86_400_000) % SLOW_NEWS.length];
    expect(email.text).toContain(
      [
        "Daily edition · Monday, September 7, 2026",
        "",
        headline,
        "Nobody queried, wrote or imported anything in acme yesterday.",
        "Slow news day: https://doco.test/workspaces/acme",
        "",
        "Yesterday in acme",
      ].join("\n"),
    );
    expect(email.html).toMatch(
      /font-size:26px[^>]*><a href="https:\/\/doco.test\/workspaces\/acme"[^>]*>[^<]+<\/a>/,
    );
    expect(digestEmail({ ...base, setting: "weekly", summary: quiet }).text).toContain(
      "Nobody queried, wrote or imported anything in acme last week.\nSlow news week: https://doco.test/workspaces/acme",
    );
  });

  it("has 30 slow-news items and runs each once a month before repeating one", () => {
    expect(new Set(SLOW_NEWS).size).toBe(30);
    const leads = Array.from({ length: 30 }, (_, day) => {
      const at = new Date(base.at.getTime() + day * 86_400_000);
      return digestEmail({ ...base, setting: "daily", at, summary: quiet }).text.split("\n")[3];
    });
    expect(new Set(leads)).toEqual(new Set(SLOW_NEWS));
  });

  it("gives yesterday's totals and tops, queries first", () => {
    const email = digestEmail({ ...base, setting: "daily" });
    expect(email.text).toContain("Yesterday in acme\n1,340 queries · 12 writes · 2,102 imports");
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
    expect(email.text).toContain("You get The Acme Times every day as a member of acme.");
  });

  it("covers last week once weekly, with a button that switches it back to daily", () => {
    const email = digestEmail({ ...base, setting: "weekly" });
    expect(email.text).toContain("Last week in acme\n1,340 queries");
    expect(email.text).toContain("Switch to daily: https://doco.test/digest/daily?t=tok");
    expect(email.html).toMatch(
      /<a href="https:\/\/doco.test\/digest\/daily\?t=tok"[^>]*>Switch to daily<\/a>/,
    );
    expect(email.text).toContain("You get The Acme Times every Monday as a member of acme.");
  });

  it("says when a list is empty", () => {
    const email = digestEmail({
      ...base,
      setting: "weekly",
      summary: { ...summary, topIntegrations: [] },
    });
    expect(email.text).toContain("Top integrations\n- None last week.");
  });

  for (const setting of ["daily", "weekly"] as const) {
    it(`unsubscribes in one click from the ${setting} edition and from the mail client`, () => {
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
