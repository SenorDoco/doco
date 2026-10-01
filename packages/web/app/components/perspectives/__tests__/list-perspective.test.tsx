import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ListPerspective, type ListPerspectiveNode } from "../list-perspective";

const ACTIVE_STAGES = new Set(["drafting", "queued", "active"]);

const closedBug = (id: string): ListPerspectiveNode => ({
  id,
  node_type: "eval",
  name: `Bug ${id}`,
  lifecycle: "retired",
  created_at: "2026-10-01T02:59:30.629Z",
});

function render(nodes: ListPerspectiveNode[]): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ListPerspective, {
        nodes,
        pageRanks: new Map(),
        visibleLifecycles: ACTIVE_STAGES,
      }),
    ),
  );
}

describe("ListPerspective when nothing shows", () => {
  it("says the Doco has no nodes when it has none", () => {
    expect(render([])).toContain("This Doco has no nodes yet.");
  });

  // A GitHub bugs Doco whose bugs are all closed holds only retired nodes,
  // which the Life cycle filter hides by default.
  it("says which Life cycle stages hide the nodes it has", () => {
    const html = render([closedBug("eval_1"), closedBug("eval_2")]);
    expect(html).not.toContain("no nodes yet");
    expect(html).toContain(
      "2 nodes are hidden by the Life cycle filter. Tick Retired to show them.",
    );
  });

  it("speaks of one hidden node in the singular", () => {
    expect(render([closedBug("eval_1")])).toContain(
      "1 node is hidden by the Life cycle filter. Tick Retired to show it.",
    );
  });
});
