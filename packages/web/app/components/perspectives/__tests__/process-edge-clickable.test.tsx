import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OverviewGraphLink } from "~/components/overview-graph";
import type { ProcessLane, ProcessNode, ProcessPool } from "~/lib/process-perspective.server";
import { ProcessLaneNode, layOutProcess } from "../process-perspective";

// A sequence-flow edge runs INSIDE the swim lane that holds its endpoints.
// The swim-lane box spans the whole pool width and sits at the same z-index
// (0) as those edges, but renders later in the DOM — and because the canvas
// wires `onNodeClick`, React Flow paints `pointer-events: all` on every node
// wrapper, the lane boxes included. Left alone the box therefore paints on top
// of the edges and swallows every click meant for them, so the edge dialog
// never opens. The lane's own click target is its label column (handled by
// ProcessLaneNode), never the box, so the box opts out of pointer events and
// the edges underneath become reachable again.
//
// ProcessLaneNode reads the live zoom through `useStore`; feed it a reading
// zoom so the label column (the lane's only interactive region) renders.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
}));

const pools: ProcessPool[] = [
  { id: "pool:i1", process_id: "i1", label: "Hire", lifecycle: "active" },
];
const lanes: ProcessLane[] = [
  {
    id: "pool:i1::principal_a",
    pool_id: "pool:i1",
    base_id: "principal_a",
    label: "Recruiter",
    kind: "actor",
    lifecycle: "active",
  },
];
const mkNode = (id: string): ProcessNode => ({
  id,
  entity_type: "action",
  name: id,
  lifecycle: "active",
  created_at: null,
  href: null,
  shape: "task",
  laneId: "pool:i1::principal_a",
  pool_id: "pool:i1",
});
const links: OverviewGraphLink[] = [
  { id: "edge_1", source: "a1", target: "a2", edge_type: "flows_to", href: "/doco/edges/edge_1" },
];

describe("process edges are clickable across swim lanes", () => {
  it("emits each swim-lane box with pointer-events: none so edge clicks fall through", () => {
    const layout = layOutProcess(
      pools,
      lanes,
      [mkNode("a1"), mkNode("a2")],
      links,
      "a1",
      new Set(),
      null,
      false,
    );
    const laneNode = layout.flowNodes.find((fn) => fn.id === "lane:pool:i1::principal_a");
    if (!laneNode) throw new Error("expected a swim-lane chrome node");
    expect((laneNode.style as { pointerEvents?: string } | undefined)?.pointerEvents).toBe("none");
  });

  it("still draws the flows_to edge with a hit target and routing data", () => {
    const layout = layOutProcess(
      pools,
      lanes,
      [mkNode("a1"), mkNode("a2")],
      links,
      "a1",
      new Set(),
      null,
      false,
    );
    const edge = layout.flowEdges.find((e) => e.id === "edge_1");
    if (!edge) throw new Error("expected the flows_to edge");
    // A wide invisible interaction path is what makes the thin stroke clickable.
    expect(edge.interactionWidth).toBeGreaterThan(0);
    // The click handler routes to the edge dialog by reading `data.graphLink`.
    expect((edge.data as { graphLink?: OverviewGraphLink } | undefined)?.graphLink?.id).toBe(
      "edge_1",
    );
  });

  it("keeps a clickable lane's label column interactive despite the box opt-out", () => {
    const html = renderToStaticMarkup(
      <ProcessLaneNode
        data={{ lane: lanes[0], height: 140, width: 800, labelWidth: 140, onLaneClick: () => {} }}
      />,
    );
    // The label column re-enables pointer events so the principal lane stays
    // clickable even though its containing box is now click-through.
    expect(html).toContain("pointer-events:auto");
  });
});
