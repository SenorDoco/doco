// The top lists beside a workspace's or Doco's activity: each says it covers
// the last 7 days, names the agent each person worked through (or the
// website), and names each integration.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ActivitySummary } from "~/lib/activity-log.server";
import { TopListsSections } from "../top-list";

const now = new Date().toISOString();
const EMPTY: ActivitySummary = {
  writes: 0,
  queries: 0,
  imports: 0,
  topContributors: [],
  topQueryers: [],
  topIntegrations: [],
};

function render(summary: ActivitySummary): string {
  return renderToStaticMarkup(createElement(TopListsSections, { summary })).replace(
    /<!-- -->/g,
    "",
  );
}

describe("TopListsSections", () => {
  it("titles each list with the last 7 days", () => {
    const html = render(EMPTY);
    for (const title of ["Top contributors", "Top queryers", "Top integrations"]) {
      expect(html).toContain(
        `${title} <span class="font-normal text-muted-foreground">· last 7 days</span>`,
      );
    }
    expect(html.indexOf("Top queryers")).toBeGreaterThan(html.indexOf("Top contributors"));
    expect(html.indexOf("Top integrations")).toBeGreaterThan(html.indexOf("Top queryers"));
  });

  it("names the agent each person worked through, marks the website, and names integrations", () => {
    const html = render({
      ...EMPTY,
      topQueryers: [
        { userId: "user_alice", username: "alice", via: "Claude Code", count: 1336, lastAt: now },
        { userId: "user_alice", username: "alice", via: null, count: 12, lastAt: now },
      ],
      topIntegrations: [{ integration: "github", name: "GitHub", count: 2102, lastAt: now }],
    });
    expect(html).toContain("via Claude Code");
    expect(html).toContain("on the website");
    expect(html).toContain("1,336");
    expect(html).toContain('aria-label="GitHub"');
    expect(html).toContain("2,102");
  });

  it("says when nothing happened in the last 7 days", () => {
    const html = render(EMPTY);
    expect(html).toContain("No writes in the last 7 days.");
    expect(html).toContain("No queries in the last 7 days.");
    expect(html).toContain("No imports in the last 7 days.");
  });
});
