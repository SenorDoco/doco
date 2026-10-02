import { describe, expect, it } from "vitest";
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
