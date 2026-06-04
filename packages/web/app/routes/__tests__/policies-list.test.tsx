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
  it("links the whole row to the policy's own page, and keeps Modify clickable", () => {
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

    // Clicking the policy opens its stable page; the Modify control still links
    // to the edit form. Two anchors: the row link + Modify.
    expect(anchorCount(html)).toBe(2);
    expect(html).toContain('href="/runbook/policies/policy_01HZARTICLE"');
    expect(html).toContain('href="/runbook/policies/policy_01HZARTICLE/edit"');
    // It must NOT link to the generic /<handle>/<type>/<id> route, which 404s
    // for the `policy` type.
    expect(html).not.toContain("/policy/policy_01HZARTICLE");
    expect(html).toContain("Import nodes as active by default.");
  });

  it("shows the policy id on the row, as selectable text, for reference", () => {
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZIDREF",
        kind: "suggestion",
        predicate: { agent_instruction: "Import nodes as active by default." },
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    // The id is rendered as visible text content (not only inside the row's
    // href), so a reader or agent can copy it to cite the policy.
    expect(html).toContain(">policy_01HZIDREF<");
    // One-click select makes it easy to copy off the list.
    expect(html).toContain("select-all");
  });

  it("links to the policy page even when the viewer cannot edit", () => {
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZREADER",
        kind: "suggestion",
        predicate: { agent_instruction: "Import nodes as active by default." },
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    // Read-only viewers get the row link but no Modify control.
    expect(anchorCount(html)).toBe(1);
    expect(html).toContain('href="/runbook/policies/policy_01HZREADER"');
    expect(html).not.toContain("/edit");
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

    // The whole-row link coexists with inner markdown links — they are DOM
    // siblings (the row link is absolutely positioned), never nested anchors.
    expect(html).toContain('href="/runbook/policies/policy_01HZMARKUP"');
    // Markdown `[label](url)` links are elevated to anchors carrying the label.
    expect(html).toContain('href="https://example.com/guide"');
    expect(html).toContain(">contributing guide");
    // Line breaks in the instruction survive rendering (the container preserves
    // whitespace) so multi-line policies read as authored.
    expect(html).toContain("whitespace-pre-wrap");
    // The raw markdown markup is consumed, not shown verbatim.
    expect(html).not.toContain("[contributing guide]");
  });

  it("shows the lifecycle stages a policy fires on, so editing them is visible", () => {
    // Regression: a policy's `fires_when_node_lifecycle` filter was editable on
    // the modify form but never rendered in the list, so removing a stage (e.g.
    // "drafting") produced no visible change — the edit looked like it hadn't
    // saved. The card must surface the stages it fires on.
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZFIRES",
        kind: "deterministic",
        predicate: {
          sub_kind: "requires_edge_role",
          edge_type: "supports",
          edge_role: "serves",
          target_node_type: "intent",
        },
        firesWhenNodeLifecycle: ["queued", "active"],
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    expect(html).toContain("fires on lifecycle");
    expect(html).toContain("queued, active");
    // "drafting" was removed, so it must not linger in the card.
    expect(html).not.toContain("drafting");
  });

  it("omits the lifecycle line when a policy fires on every stage", () => {
    // No `fires_when_node_lifecycle` means "fires regardless of lifecycle" —
    // there's nothing meaningful to show, so the line is suppressed.
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZALLLC",
        kind: "deterministic",
        predicate: { sub_kind: "requires_node_type", node_types: ["action"] },
        firesWhenNodeLifecycle: null,
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });
    expect(html).not.toContain("fires on lifecycle");
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
    // canEdit=false → no Modify link, but the row still links to the policy page.
    expect(anchorCount(html)).toBe(1);
    expect(html).toContain('href="/runbook/policies/policy_01HZDET"');
  });
});
