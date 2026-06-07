import { describe, expect, it } from "vitest";
import { GRAPH_MIN_ZOOM as OVERVIEW_MIN_ZOOM } from "../../overview-graph";
import { ORG_TREE_MIN_ZOOM } from "../org-tree-perspective";
import { PROCESS_MIN_ZOOM } from "../process-perspective";

// Wide diagrams (long BPMN swim lanes, sprawling org trees, dense overview
// graphs) only fit on screen if `fitView` — and manual scroll/pinch — can
// reach a small enough zoom. ReactFlow clamps the reachable zoom at
// `minZoom`, so a high floor leaves big diagrams cropped at the edges. Keep
// every graph perspective able to zoom out far enough to see the whole thing.
const MAX_ALLOWED_MIN_ZOOM = 0.05;

describe("graph perspectives can zoom out to fit large diagrams", () => {
  it.each([
    ["BPMN", PROCESS_MIN_ZOOM],
    ["org tree", ORG_TREE_MIN_ZOOM],
    ["overview graph", OVERVIEW_MIN_ZOOM],
  ])("lets %s zoom out far enough", (_name, minZoom) => {
    expect(minZoom).toBeLessThanOrEqual(MAX_ALLOWED_MIN_ZOOM);
  });
});
