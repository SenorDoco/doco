import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OverviewFlowNode } from "~/components/overview-graph";
import type { OrgTreeNode } from "~/lib/org-tree-perspective.server";
import type { ProcessNode } from "~/lib/process-perspective.server";
import {
  ReferenceNumberStoreContext,
  createReferenceNumberStore,
} from "~/lib/reference-number-store";
import { OrgTreeCard } from "../org-tree-perspective";
import { ProcessRectangleNode } from "../process-perspective";

// Every graph perspective wires `onNodeClick` to re-focus (and navigate),
// so a node is always interactive. React Flow's default node wrapper paints
// `cursor: default` (it only switches to `pointer` for `selectable` nodes,
// which we opt out of), so a clickable node only shows the pointer
// affordance if its own component sets one. These render checks lock that
// affordance in: the bug was that mousing over nodes didn't read as
// clickable because the cursor stayed an arrow.
//
// `useProcessSimplified` reads zoom via `useStore`; the mock feeds a
// zoomed-out transform so the shape renders as a plain box (no badge/label
// children that would need the reference-number store) — the cursor lives
// on the shape's root either way.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 0.3] }),
}));

const orgNode: OrgTreeNode = {
  id: "principal_1",
  name: "Hiring Manager",
  role: "Owns the req",
  type: "person",
  lifecycle: "active",
  reports_to: null,
  reports_to_lifecycle: null,
  dotted_reports_to: [],
  href: "/doco/principal/principal_1",
};

const processNode: ProcessNode = {
  id: "node_1",
  entity_type: "action",
  name: "Review application",
  lifecycle: "active",
  created_at: null,
  href: "/doco/action/node_1",
  shape: "rectangle",
  laneId: "lane_1",
  pool_id: "pool_1",
};

describe("clickable node cursor", () => {
  it("org-tree card shows a pointer cursor", () => {
    const html = renderToStaticMarkup(
      createElement(OrgTreeCard, { data: { org: orgNode, isCenter: false } } as never),
    );
    expect(html).toContain("cursor-pointer");
  });

  it("process shape shows a pointer cursor", () => {
    const html = renderToStaticMarkup(
      createElement(ProcessRectangleNode, { data: { node: processNode, isCenter: false } }),
    );
    expect(html).toContain("cursor-pointer");
  });

  it("overview graph node shows a pointer cursor", () => {
    const html = renderToStaticMarkup(
      createElement(
        ReferenceNumberStoreContext.Provider,
        { value: createReferenceNumberStore(new Map()) },
        createElement(OverviewFlowNode, {
          data: {
            node: {
              id: "node_1",
              entity_type: "decision",
              name: "Approve budget",
              lifecycle: "active",
              created_at: null,
              href: "/doco/decision/node_1",
            },
            showDetail: false,
            isNew: false,
            opacity: 1,
          },
        }),
      ),
    );
    expect(html).toContain("cursor-pointer");
  });
});
