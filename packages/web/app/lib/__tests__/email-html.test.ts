import { describe, expect, it } from "vitest";
import { digestEmail } from "../activity-digest";
import { emailHtml } from "../email-html";
import { reminderEmail, welcomeEmail } from "../onboarding-emails";
import { alertEmail } from "../silence-alerts.server";

// Every email Doco sends wears the site's look: torre.ai's #f3f2ee background
// and its face, Merriweather, falling back to Georgia where a mail client
// won't load web fonts (Gmail, Outlook).
describe("emailHtml", () => {
  const html = emailHtml(["Hello & welcome", { link: "https://doco.to/x", label: "Open x" }]);

  it("paints the whole email with torre.ai's background", () => {
    expect(html).toContain('bgcolor="#f3f2ee"');
    expect(html).toMatch(/<body style="[^"]*background-color:#f3f2ee/);
  });

  it("sets the text in Merriweather, then Georgia, then any serif", () => {
    expect(html).toContain("font-family:Merriweather,Georgia,'Times New Roman',serif");
    expect(html).toContain("https://fonts.googleapis.com/css2?family=Merriweather");
  });

  it("escapes text and links each URL a paragraph mentions", () => {
    expect(html).toContain("Hello &amp; welcome");
    const withUrl = emailHtml(["Revoke it at https://doco.to/tokens and it goes away."]);
    expect(withUrl).toContain('<a href="https://doco.to/tokens"');
    expect(withUrl).toContain(">https://doco.to/tokens</a> and it goes away.");
  });

  it("sets preformatted text in Ubuntu Mono on the site's input color", () => {
    const pre = emailHtml([{ pre: "<!-- doco:begin -->" }]);
    expect(pre).toContain("font-family:'Ubuntu Mono',ui-monospace,Menlo,Consolas,monospace");
    expect(pre).toContain("background-color:#e9e8e4");
    expect(pre).toContain("&lt;!-- doco:begin --&gt;");
  });

  // The site's own Ubuntu Mono, drawn 120% so it stands as tall as
  // Merriweather (typography.test.ts). Clients that load web fonts (Apple
  // Mail) take it; the rest fall back to their own monospace.
  it("loads the site's Ubuntu Mono, drawn at Merriweather's size", () => {
    expect(html).toContain(
      "@font-face{font-family:'Ubuntu Mono';src:url(https://doco.to/fonts/ubuntu-mono-400.woff2) format('woff2');size-adjust:120%}",
    );
    expect(html).not.toContain("Ubuntu+Mono");
  });

  it("sets headings, lists (an item may end in a link), numbers and small print, escaped", () => {
    const html = emailHtml([
      { heading: "Top <queryers>" },
      { list: ["ana & bo", { text: "Ship <it>.", link: "https://doco.to/a?b&c", label: "acme" }] },
      { stats: [{ value: "1,340", label: "queries" }] },
      {
        footer: "You get this as a member.",
        link: "https://doco.to/u?t=a&b",
        label: "Unsubscribe",
      },
    ]);
    // A heading that opens the email sits flush with the top of the slab.
    expect(html).toContain('<p style="margin:0 0 8px;font-weight:700">Top &lt;queryers&gt;</p>');
    expect(emailHtml(["Hi.", { heading: "Top" }])).toContain(
      '<p style="margin:24px 0 8px;font-weight:700">Top</p>',
    );
    expect(html).toContain("<li>ana &amp; bo</li>");
    expect(html).toContain(
      '<li>Ship &lt;it&gt;. (<a href="https://doco.to/a?b&amp;c" style="color:#9c44a5">acme</a>)</li>',
    );
    expect(html).toMatch(/font-size:24px[^>]*>1,340<\/div><div style="color:#5c5b56">queries</);
    expect(html).toContain(
      'You get this as a member. <a href="https://doco.to/u?t=a&amp;b" style="color:#9c44a5">Unsubscribe</a>',
    );
  });

  // The site's one clay (Alexander, 2026-10-03), as far as mail clients allow:
  // the column is a slab, the button a purple key, preformatted text a well,
  // nothing has an outline, and every link is purple. Apple Mail, iOS Mail and
  // Gmail honour the inline box-shadows; Outlook drops them and shows the same
  // email flat on the page, which still reads.
  it("stands the email on a slab, with a purple key for a button and a well for code", () => {
    const html = emailHtml(["Hi", { link: "https://doco.to/x", label: "Open x" }, { pre: "x" }]);
    expect(html).toContain("box-shadow:7px 7px 16px rgba(23,22,18,0.09),-7px -7px 16px #ffffff");
    expect(html).toMatch(
      /<a href="https:\/\/doco.to\/x" style="[^"]*background-color:#9c44a5;color:#ffffff[^"]*box-shadow:5px 5px 12px rgba\(23,22,18,0.11\),-5px -5px 12px #ffffff/,
    );
    expect(html).toMatch(
      /<pre style="[^"]*box-shadow:inset 4px 4px 9px rgba\(23,22,18,0.13\),inset -4px -4px 9px #ffffff/,
    );
    expect(html).not.toContain("border:");
  });

  // The site's plain key: the page's clay with purple text, for the action
  // beside the main one.
  it("draws a quiet button as a clay key with purple text", () => {
    const html = emailHtml([{ link: "https://doco.to/y", label: "Switch", quiet: true }]);
    expect(html).toMatch(
      /<a href="https:\/\/doco.to\/y" style="[^"]*background-color:#f3f2ee;color:#9c44a5[^"]*box-shadow:5px 5px 12px rgba\(23,22,18,0.11\),-5px -5px 12px #ffffff[^"]*">Switch<\/a>/,
    );
  });
});

describe("Doco's emails", () => {
  const base = "https://doco.test";
  const emails = {
    welcome: welcomeEmail({ baseUrl: base, workspaceHandle: "acme" }),
    reminder: reminderEmail({
      baseUrl: base,
      workspaceHandle: "acme",
      steps: [
        { step: "github", done: true },
        { step: "sources", done: false },
        { step: "agent", done: false },
      ],
    }),
    alert: alertEmail(
      "owner@example.com",
      [
        {
          id: "alert_1",
          kind: "integration",
          workspaceHandle: "acme",
          docoHandle: "acme-slack",
          source: "slack",
          quietSince: "2026-10-01T10:00:00.000Z",
          usual: 11,
        },
      ],
      base,
    ),
    digest: digestEmail({
      baseUrl: base,
      workspaceHandle: "acme",
      setting: "weekly",
      summary: {
        writes: 0,
        queries: 0,
        imports: 0,
        topContributors: [],
        topQueryers: [],
        topIntegrations: [],
      },
      top: [],
      token: "tok",
    }),
  };

  for (const [name, email] of Object.entries(emails)) {
    it(`sends the ${name} email in the site's look`, () => {
      expect(email.html).toContain('bgcolor="#f3f2ee"');
      expect(email.html).toContain("font-family:Merriweather,Georgia");
    });
  }

  it("links the alert's connection page", () => {
    expect(emails.alert.html).toContain(
      '<a href="https://doco.test/acme-slack/integrations/slack"',
    );
  });
});
