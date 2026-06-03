import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ReferenceNumberStoreContext,
  createReferenceNumberStore,
} from "~/lib/reference-number-store";
import { OverviewReferenceBadge } from "../overview-graph";

// The Graph perspective recomputes its #N reference numbering on every
// pan/zoom frame (the numbers reflect on-screen reading order). The
// numbers must NOT be baked into each React Flow node's `data` — doing so
// rebuilds the whole `nodes` array every frame and re-renders every card,
// which is what made a 100-node Doco impossible to navigate. Instead each
// badge subscribes to *its own* number through the reference-number store
// (the same pattern the BPMN perspective already uses), so the node array
// stays referentially stable across pans and only the handful of badges
// whose number actually changed re-render.
describe("OverviewReferenceBadge", () => {
  it("renders the node's #N from the reference-number store, not node data", () => {
    const store = createReferenceNumberStore(new Map([["node_x", 12]]));
    const html = renderToStaticMarkup(
      createElement(
        ReferenceNumberStoreContext.Provider,
        { value: store },
        createElement(OverviewReferenceBadge, { nodeId: "node_x", label: "X" }),
      ),
    );
    expect(html).toContain("#12");
  });

  it("renders nothing for a node that has no number in the store", () => {
    const store = createReferenceNumberStore(new Map([["node_x", 12]]));
    const html = renderToStaticMarkup(
      createElement(
        ReferenceNumberStoreContext.Provider,
        { value: store },
        createElement(OverviewReferenceBadge, { nodeId: "node_y", label: "Y" }),
      ),
    );
    expect(html).toBe("");
  });
});
