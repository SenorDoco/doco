import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { NodeDialogDetail, NodeDialogEdge } from "~/lib/node-detail.server";
import { EdgeList, NodeDialog, isRetiredEdgeRow } from "../node-dialog";

/** Strip HTML tags to recover the visible text content. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ");
}

function edge(overrides: Partial<NodeDialogEdge>): NodeDialogEdge {
  return {
    edge_id: "edge_x",
    edge_type: "supports",
    edge_label: null,
    edge_lifecycle: "active",
    edge_href: "/acme/edges/edge_x",
    other_id: "decision_x",
    other_node_type: "decision",
    other_summary: null,
    other_name: "Other node",
    other_lifecycle: "active",
    href: "/acme/decision/decision_x",
    ...overrides,
  };
}

function detail(overrides: Partial<NodeDialogDetail>): NodeDialogDetail {
  return {
    id: "decision_01",
    node_type: "decision",
    summary: "Root node",
    name: "Root node",
    primary_field: "decision",
    primary_text: "Root node",
    lifecycle: "active",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:00:00.000Z",
    authoring: { created: null, updated: null },
    locator: null,
    github_repo: null,
    doco: { handle: "acme", href: "/acme" },
    frontmatter: {},
    raw_json: "{}",
    href: "/acme/decision/decision_01",
    update_url: null,
    user_role: null,
    can_change_lifecycle: false,
    lifecycle_options: [],
    outgoing: [],
    incoming: [],
    history: [],
    lifecycle_history: [],
    ...overrides,
  };
}

function render(d: NodeDialogDetail): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NodeDialog
        detail={d}
        loading={false}
        error={null}
        lifecycleUpdating={null}
        lifecycleError={null}
        onClose={() => {}}
        onLifecycleChange={() => {}}
        onOpenNode={() => {}}
        onOpenEdge={() => {}}
      />
    </MemoryRouter>,
  );
}

describe("isRetiredEdgeRow", () => {
  it("is retired when the edge itself is retired", () => {
    expect(isRetiredEdgeRow({ edge_lifecycle: "retired", other_lifecycle: "active" })).toBe(true);
  });

  it("is retired when the node on the other end is retired", () => {
    expect(isRetiredEdgeRow({ edge_lifecycle: "active", other_lifecycle: "retired" })).toBe(true);
  });

  it("is not retired when both the edge and the other node are live", () => {
    expect(isRetiredEdgeRow({ edge_lifecycle: "active", other_lifecycle: "active" })).toBe(false);
  });
});

describe("NodeDialog retired edges and nodes", () => {
  it("hides retired edge rows by default and offers a reveal button", () => {
    const html = render(
      detail({
        outgoing: [
          edge({ edge_id: "e_live", other_id: "d_live", other_name: "Live neighbour" }),
          edge({
            edge_id: "e_retired_node",
            other_id: "d_dead",
            other_name: "Retired neighbour",
            other_lifecycle: "retired",
          }),
        ],
        incoming: [
          edge({
            edge_id: "e_retired_edge",
            other_id: "d_other",
            other_name: "Reached by retired edge",
            edge_lifecycle: "retired",
          }),
        ],
      }),
    );

    const visible = text(html);
    // The live edge's neighbour shows; the retired ones are hidden by default.
    expect(visible).toContain("Live neighbour");
    expect(visible).not.toContain("Retired neighbour");
    expect(visible).not.toContain("Reached by retired edge");
    // Two retired rows → the button surfaces with the count.
    expect(visible).toContain("Show retired edges and nodes (2)");
  });

  it("offers no reveal button when nothing is retired", () => {
    const html = render(
      detail({
        outgoing: [edge({ edge_id: "e_live", other_name: "Live neighbour" })],
      }),
    );
    expect(text(html)).not.toContain("Show retired edges and nodes");
  });
});

function renderEdgeList(edges: NodeDialogEdge[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <EdgeList
        label="Outgoing"
        direction="outgoing"
        currentNodeId="decision_01"
        edges={edges}
        onOpenNode={() => {}}
        onOpenEdge={() => {}}
      />
    </MemoryRouter>,
  );
}

describe("EdgeList retired-edge strikethrough", () => {
  it("strikes through the edge type when the edge itself is retired", () => {
    const html = renderEdgeList([
      edge({ edge_id: "e_dead", edge_type: "flows_to", edge_lifecycle: "retired" }),
    ]);
    // The span carrying the edge type must wear the line-through class.
    expect(html).toMatch(/class="[^"]*line-through[^"]*"[^>]*>flows_to/);
  });

  it("strikes through the edge label too when the edge is retired", () => {
    const html = renderEdgeList([
      edge({
        edge_id: "e_dead",
        edge_type: "flows_to",
        edge_label: "on approval",
        edge_lifecycle: "retired",
      }),
    ]);
    expect(html).toMatch(/class="[^"]*line-through[^"]*"[^>]*>on approval/);
  });

  it("does not strike through the edge type of a live edge", () => {
    const html = renderEdgeList([
      edge({ edge_id: "e_live", edge_type: "flows_to", edge_lifecycle: "active" }),
    ]);
    expect(html).not.toMatch(/class="[^"]*line-through[^"]*"[^>]*>flows_to/);
  });
});
