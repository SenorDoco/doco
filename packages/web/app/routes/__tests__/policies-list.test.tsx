import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

// The route module imports server-only helpers (loader dependencies) at the
// top level. Stub them so importing the component for a static render doesn't
// drag in Postgres/session machinery.
vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: vi.fn(),
  canEditPolicies: vi.fn(),
}));
vi.mock("~/lib/host.server", () => ({ loadHostConfig: vi.fn() }));
vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));

import { ArticleSection } from "../$docoHandle.policies";

function renderSection(props: Parameters<typeof ArticleSection>[0]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(ArticleSection, props)),
  );
}

function anchorCount(html: string): number {
  return (html.match(/<a\b/g) ?? []).length;
}

describe("ArticleSection (policies list)", () => {
  it("does not turn the policy text into a link — only Modify is clickable", () => {
    const html = renderSection({
      title: "Guidance policies",
      entityType: "guidance_policy",
      description: "Policies AI agents read while working.",
      addHref: null,
      editHrefBase: "/runbook/policies/guidance",
      items: [
        {
          id: "guidance_policy_01HZARTICLE",
          policy: "Import nodes as asserted by default.",
          lifecycle: "asserted",
          createdAt: "2026-06-01T00:00:00.000Z",
          body: "",
        },
      ],
      empty: "No guidance policies yet.",
    });

    // The /<handle>/<type>/<id> detail route 404s for policy types, so the
    // row must not link there — the only anchor left is the Modify button.
    expect(anchorCount(html)).toBe(1);
    expect(html).not.toContain("/guidance_policy/guidance_policy_01HZARTICLE");
    expect(html).toContain("Import nodes as asserted by default.");
    expect(html).toContain('href="/runbook/policies/guidance/guidance_policy_01HZARTICLE/edit"');
  });
});
