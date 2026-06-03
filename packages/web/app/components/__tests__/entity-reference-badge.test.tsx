import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ReferenceNumberStoreContext,
  createReferenceNumberStore,
} from "~/lib/reference-number-store";
import { EntityReferenceBadge } from "../entity-graph";

// Same contract as the Graph perspective: the #N must come from the
// reference-number store, not the React Flow node `data`, so the numbers
// can shuffle on every pan frame without rebuilding the nodes array and
// re-rendering every entity card.
describe("EntityReferenceBadge", () => {
  it("renders the node's #N from the reference-number store, not node data", () => {
    const store = createReferenceNumberStore(new Map([["node_x", 3]]));
    const html = renderToStaticMarkup(
      createElement(
        ReferenceNumberStoreContext.Provider,
        { value: store },
        createElement(EntityReferenceBadge, { nodeId: "node_x", label: "X" }),
      ),
    );
    expect(html).toContain("#3");
  });

  it("renders nothing for a node that has no number in the store", () => {
    const store = createReferenceNumberStore(new Map([["node_x", 3]]));
    const html = renderToStaticMarkup(
      createElement(
        ReferenceNumberStoreContext.Provider,
        { value: store },
        createElement(EntityReferenceBadge, { nodeId: "node_y", label: "Y" }),
      ),
    );
    expect(html).toBe("");
  });
});
