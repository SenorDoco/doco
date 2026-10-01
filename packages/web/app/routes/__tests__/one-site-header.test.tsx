import { readFileSync, readdirSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

// root.tsx imports the session and inbox helpers, which pull in @doco/db at the
// top level; stub them so the static render doesn't drag in Postgres.
vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: vi.fn() }));
vi.mock("~/lib/access-requests.server", () => ({ countPendingAccessRequestsForOwner: vi.fn() }));
vi.mock("~/lib/feedback-reports.server", () => ({ countPendingFeedback: vi.fn() }));
vi.mock("~/components/agent-sidebar", () => ({
  AgentSidebar: () => createElement("aside", null, "Señor Doco"),
}));
vi.mock("~/components/feedback-reporter", () => ({ FeedbackReporter: () => null }));
vi.mock("~/components/doco-mark", () => ({
  DocoMark: () => createElement("span", null, "Doco"),
}));
vi.mock("~/components/version-pill", () => ({ VersionPill: () => null }));

import type { CurrentPrincipal } from "~/lib/session.server";
import App, { ErrorBoundary } from "../../root";

const ana: CurrentPrincipal = { id: "user_ana", username: "ana", type: "person", isHuman: true };

function render(me: CurrentPrincipal | null, error?: Error): string {
  const router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        loader: () => null,
        Component: App,
        ErrorBoundary,
        children: [{ index: true, Component: () => createElement("p", null, "page body") }],
      },
    ],
    {
      initialEntries: ["/"],
      hydrationData: {
        loaderData: { root: { me, feedbackPending: null, accessRequestsPending: 0 } },
        ...(error ? { errors: { root: error } } : {}),
      },
    },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

function headerRowClass(html: string): string {
  const match = html.match(/<header[^>]*><div class="([^"]*)"/);
  if (!match) throw new Error(`no header row in markup: ${html}`);
  return match[1];
}

/**
 * Every page carries the same header: the root layout draws it once, for
 * signed-in and signed-out visitors alike, and it spans the window. Pages used
 * to draw their own, and the copies drifted apart (the home page's sat in a
 * 768px column, sign-in's in a 1152px one, the app's spanned the window).
 */
describe("one site header", () => {
  it("draws the header above the page for a signed-out visitor, with Sign in", () => {
    const html = render(null);
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain("page body");
    expect(html).not.toContain("Señor Doco");
  });

  it("draws the same header for a signed-in person, beside Señor Doco", () => {
    const html = render(ana);
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).toContain("@ana");
    expect(html).not.toContain('href="/sign-in"');
    expect(html).toContain("Señor Doco");
    expect(html).toContain("page body");
  });

  it("spans the window instead of sitting in a centered column", () => {
    for (const me of [null, ana]) {
      const row = headerRowClass(render(me));
      expect(row).toMatch(/(?:^|\s)w-full(?:\s|$)/);
      expect(row).not.toMatch(/max-w-/);
      expect(row).not.toMatch(/mx-auto/);
    }
  });

  it("keeps the header on error pages, so there is a way back", () => {
    const html = render(ana, new Error("boom"));
    expect(html.match(/<header/g)).toHaveLength(1);
    expect(html).toContain("@ana");
    expect(html).toContain("boom");
  });

  it("leaves no page drawing a header of its own", () => {
    const app = new URL("../../", import.meta.url);
    const sources = [
      ...readdirSync(new URL("routes/", app))
        .filter((f) => f.endsWith(".tsx"))
        .map((f) => `routes/${f}`),
      ...readdirSync(new URL("components/", app), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".tsx") && !f.includes("__tests__"))
        .map((f) => `components/${f}`),
    ];
    const offenders = sources.filter((path) => {
      if (path === "components/site-header.tsx") return false;
      const source = readFileSync(new URL(path, app), "utf8");
      return /<SiteHeader\b|<VersionPill\b|SiteHeaderSuppression/.test(source);
    });
    expect(offenders).toEqual([]);
    const root = readFileSync(new URL("root.tsx", app), "utf8");
    expect(root.match(/<SiteHeader\b/g)).toHaveLength(1);
    expect(root).not.toContain("SiteHeaderSuppression");
  });
});
