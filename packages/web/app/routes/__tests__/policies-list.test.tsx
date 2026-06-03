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
      },
    });

    // The /<handle>/<type>/<id> detail route 404s for the `policy` type, so the
    // row must not link there — the only anchor left is the Modify button.
    expect(anchorCount(html)).toBe(1);
    expect(html).not.toContain("/policy/policy_01HZARTICLE");
    expect(html).toContain("Import nodes as active by default.");
    expect(html).toContain('href="/runbook/policies/policy_01HZARTICLE/edit"');
  });

  it("renders the agent instruction without wrapping curly quotation marks", () => {
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZQUOTE",
        kind: "suggestion",
        predicate: { agent_instruction: "Import nodes as active by default." },
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    // The text is already labeled "Agent instruction:" above it, so the row
    // shows the instruction bare — no decorative curly quotes wrapping it.
    expect(html).toContain("Import nodes as active by default.");
    expect(html).not.toContain("“"); // left double quotation mark
    expect(html).not.toContain("”"); // right double quotation mark
  });

  it("renders the agent instruction with markdown links and preserved line breaks", () => {
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZMARKUP",
        kind: "suggestion",
        predicate: {
          agent_instruction:
            "Import nodes as active by default.\nSee the [contributing guide](https://example.com/guide).",
        },
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    // Markdown `[label](url)` links are elevated to anchors carrying the label.
    expect(html).toContain('href="https://example.com/guide"');
    expect(html).toContain(">contributing guide");
    // Line breaks in the instruction survive rendering (the container preserves
    // whitespace) so multi-line policies read as authored.
    expect(html).toContain("whitespace-pre-wrap");
    // The raw markdown markup is consumed, not shown verbatim.
    expect(html).not.toContain("[contributing guide]");
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
