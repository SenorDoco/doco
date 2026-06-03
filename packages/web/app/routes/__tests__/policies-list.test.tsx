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

import { PolicyRow } from "../$docoHandle.policies";

function renderRow(props: Parameters<typeof PolicyRow>[0]): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PolicyRow, props)));
}

function anchorCount(html: string): number {
  return (html.match(/<a\b/g) ?? []).length;
}

describe("PolicyRow (policies list)", () => {
  it("does not turn the policy text into a link — only Modify is clickable", () => {
    const html = renderRow({
      handle: "runbook",
      canEdit: true,
      item: {
        id: "policy_01HZARTICLE",
        kind: "suggestion",
        predicate: { agent_instruction: "Import nodes as active by default." },
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
        body: "",
      },
    });

    // The /<handle>/<type>/<id> detail route 404s for the `policy` type, so the
    // row must not link there — the only anchor left is the Modify button.
    expect(anchorCount(html)).toBe(1);
    expect(html).not.toContain("/policy/policy_01HZARTICLE");
    expect(html).toContain("Import nodes as active by default.");
    expect(html).toContain('href="/runbook/policies/policy_01HZARTICLE/edit"');
  });

  it("renders the kind label and, for deterministic, the structured parts", () => {
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZDET",
        kind: "deterministic",
        predicate: {
          sub_kind: "requires_edge_role",
          edge_type: "attributed_to",
          edge_role: "performed_by",
          target_node_type: "principal",
        },
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
        body: "",
      },
    });

    expect(html).toContain("Deterministic");
    expect(html).toContain("Requires edge role");
    expect(html).toContain("attributed_to");
    expect(html).toContain("performed_by");
    // canEdit=false → no Modify link.
    expect(anchorCount(html)).toBe(0);
  });
});
