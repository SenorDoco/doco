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

import { toPolicyItem } from "~/components/policy-view";
import Policies, { PolicyRow } from "../$docoHandle.policies";

function renderRow(props: Parameters<typeof PolicyRow>[0]): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PolicyRow, props)));
}

function renderPage(loaderData: Parameters<typeof Policies>[0]["loaderData"]): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(Policies, { loaderData })),
  );
}

function makeLoaderData(
  overrides: Partial<Parameters<typeof Policies>[0]["loaderData"]> = {},
): Parameters<typeof Policies>[0]["loaderData"] {
  return {
    ownerSlug: "torre",
    docoSlug: "runbook",
    handle: "runbook" as unknown as Parameters<typeof Policies>[0]["loaderData"]["handle"],
    me: null,
    host: {} as never,
    canEdit: false,
    activePolicies: [],
    retiredPolicies: [],
    ...overrides,
  };
}

const samplePolicy = (id: string, lifecycle: string) => ({
  id,
  kind: "suggestion" as const,
  predicate: { agent_instruction: "Import nodes as active by default." },
  lifecycle,
  createdAt: "2026-06-01T00:00:00.000Z",
});

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
          sub_kind: "requires_edge",
          edge_type: "supports",
          target_node_type: "intent",
        },
        firesWhenNodeLifecycle: ["queued", "active"],
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    // Rendered as just another labeled row, identical to the predicate parts
    // (`<dt>` label + `<dd>` value) — nothing special about it.
    expect(html).toContain('<dt class="text-muted-foreground">fires on lifecycle</dt>');
    expect(html).toContain('<dd class="font-mono text-foreground">queued, active</dd>');
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

  it("shows the node type a node-scoped probabilistic policy judges (when_node_type)", () => {
    // The screenshot's probabilistic policies judge one node type ("the
    // Principal's prose") — that scope lives in `when_node_type` but was never
    // rendered for prose policies, so two policies judging different node types
    // looked identical. Surface it as a labeled part.
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZSCOPE",
        kind: "probabilistic",
        predicate: {
          agent_instruction: "Check the Principal's prose.",
          when_node_type: ["principal"],
        },
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    expect(html).toContain('<dt class="text-muted-foreground">when node type</dt>');
    expect(html).toContain('<dd class="font-mono text-foreground">principal</dd>');
    expect(html).toContain("Check the Principal&#x27;s prose.");
  });

  it("shows the edge an edge-scoped probabilistic policy fires on, as labeled parts", () => {
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZEDGE",
        kind: "probabilistic",
        predicate: {
          agent_instruction: "Judge the relationship.",
          edge_type: "supports",
          from_node_type: "intent",
          to_node_type: "decision",
        },
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    expect(html).toContain('<dt class="text-muted-foreground">edge type</dt>');
    expect(html).toContain('<dd class="font-mono text-foreground">supports</dd>');
    expect(html).toContain('<dt class="text-muted-foreground">from node type</dt>');
    expect(html).toContain('<dd class="font-mono text-foreground">intent</dd>');
    expect(html).toContain('<dt class="text-muted-foreground">to node type</dt>');
    expect(html).toContain('<dd class="font-mono text-foreground">decision</dd>');
  });

  it("shows the on-violation action for an enforced (non-suggestion) policy", () => {
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZVIOL",
        kind: "probabilistic",
        predicate: { agent_instruction: "Judge the node." },
        onViolation: "warn",
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    expect(html).toContain('<dt class="text-muted-foreground">on violation</dt>');
    expect(html).toContain('<dd class="font-mono text-foreground">warn</dd>');
  });

  it("omits the on-violation action for a suggestion (advisory only)", () => {
    // Suggestions never block — `on_violation` is meaningless for them, so it is
    // not shown even when present on the stored data.
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZADV",
        kind: "suggestion",
        predicate: { agent_instruction: "Prefer concise names." },
        onViolation: "block",
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    expect(html).not.toContain("on violation");
  });

  it("renders the kind label and, for deterministic, the structured parts", () => {
    const html = renderRow({
      handle: "runbook",
      canEdit: false,
      item: {
        id: "policy_01HZDET",
        kind: "deterministic",
        predicate: {
          sub_kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
        },
        lifecycle: "active",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    });

    expect(html).toContain("Deterministic");
    // With `role` gone the headline is "Requires edge" and the structured parts
    // are the edge type + its target endpoint (no role).
    expect(html).toContain("Requires edge");
    expect(html).toContain("attributed_to");
    expect(html).toContain("principal");
    // canEdit=false → no Modify link, but the row still links to the policy page.
    expect(anchorCount(html)).toBe(1);
    expect(html).toContain('href="/runbook/policies/policy_01HZDET"');
  });
});

describe("toPolicyItem", () => {
  it("carries the on-violation action off the stored policy data", () => {
    const item = toPolicyItem({
      id: "policy_01HZMAP",
      kind: "deterministic",
      lifecycle: "active",
      created_at: "2026-06-01T00:00:00.000Z",
      data: {
        kind: "deterministic",
        predicate: { sub_kind: "requires_node_type", node_types: ["action"] },
        on_violation: "warn",
        fires_when_node_lifecycle: ["active"],
      },
    });

    expect(item.onViolation).toBe("warn");
    expect(item.firesWhenNodeLifecycle).toEqual(["active"]);
  });

  it("leaves on-violation null when the data omits it", () => {
    const item = toPolicyItem({
      id: "policy_01HZNONE",
      kind: "suggestion",
      lifecycle: "active",
      created_at: "2026-06-01T00:00:00.000Z",
      data: { kind: "suggestion", predicate: { agent_instruction: "Be concise." } },
    });

    expect(item.onViolation).toBeNull();
  });
});

describe("Policies page (active / retired sections)", () => {
  it("renders an Active policies section listing only active policies", () => {
    const html = renderPage(
      makeLoaderData({
        activePolicies: [samplePolicy("policy_01HZACTIVE", "active")],
        retiredPolicies: [samplePolicy("policy_01HZRETIRED", "retired")],
      }),
    );

    expect(html).toContain("Active policies");
    expect(html).toContain('href="/runbook/policies/policy_01HZACTIVE"');
  });

  it("renders a Retired policies section when there are retired policies", () => {
    const html = renderPage(
      makeLoaderData({
        activePolicies: [samplePolicy("policy_01HZACTIVE", "active")],
        retiredPolicies: [samplePolicy("policy_01HZRETIRED", "retired")],
      }),
    );

    expect(html).toContain("Retired policies");
    expect(html).toContain('href="/runbook/policies/policy_01HZRETIRED"');
  });

  it("omits the Retired policies section entirely when none are retired", () => {
    const html = renderPage(
      makeLoaderData({
        activePolicies: [samplePolicy("policy_01HZACTIVE", "active")],
        retiredPolicies: [],
      }),
    );

    expect(html).toContain("Active policies");
    expect(html).not.toContain("Retired policies");
  });

  it("renders a retired policy struck through in red, but not an active one", () => {
    const retired = renderRow({
      handle: "runbook",
      canEdit: false,
      item: samplePolicy("policy_01HZRETIRED", "retired"),
    });
    const active = renderRow({
      handle: "runbook",
      canEdit: false,
      item: samplePolicy("policy_01HZACTIVE", "active"),
    });

    // Retired policies read as crossed out, in the destructive (red) color, so
    // it's obvious at a glance they're no longer in force.
    expect(retired).toContain("line-through");
    expect(retired).toContain("text-destructive");
    // Active policies carry no such styling.
    expect(active).not.toContain("line-through");
  });
});
