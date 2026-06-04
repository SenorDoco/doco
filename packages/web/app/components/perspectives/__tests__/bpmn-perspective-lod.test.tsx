import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BpmnLane, BpmnPool } from "~/lib/bpmn-perspective.server";
import { BpmnLaneNode, BpmnPoolHeaderNode } from "../bpmn-perspective";

// `useBpmnSimplified` reads the live zoom via
// `useStore((s) => bpmnSimplifiedAtZoom(s.transform[2]))`. Drive that zoom
// by feeding the selector a fake store whose transform carries our test
// value. A full mock (rather than importActual) keeps the real Handle /
// edge components out of SSR — they need a ReactFlow provider we don't
// mount here.
const flowMock = vi.hoisted(() => ({ zoom: 1 }));
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  MarkerType: { ArrowClosed: "arrowclosed" },
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, flowMock.zoom] }),
}));

function render(node: ReactElement): string {
  return renderToStaticMarkup(node);
}

const intentPool: BpmnPool = {
  id: "pool:intent_1",
  intent_id: "intent_1",
  label: "Post a job",
  lifecycle: "active",
};

const actorLane: BpmnLane = {
  id: "pool:intent_1::principal_1",
  pool_id: "pool:intent_1",
  base_id: "principal_1",
  label: "Hiring Manager",
  kind: "actor",
  lifecycle: "active",
};

afterEach(() => {
  flowMock.zoom = 1;
});

describe("BPMN pool/lane chrome under LOD", () => {
  describe("pool header", () => {
    it("shows the label and type badge at reading zoom", () => {
      flowMock.zoom = 1;
      const html = render(
        <BpmnPoolHeaderNode data={{ pool: intentPool, width: 800, height: 32 }} />,
      );
      expect(html).toContain("Post a job");
      expect(html).toContain("Intent");
    });

    it("drops the label and badges when zoomed out past the LOD threshold", () => {
      flowMock.zoom = 0.3;
      const html = render(
        <BpmnPoolHeaderNode data={{ pool: intentPool, width: 800, height: 32 }} />,
      );
      // The pool collapses to a plain tinted band — no label, no
      // type/lifecycle pills — matching how shape nodes simplify.
      expect(html).not.toContain("Post a job");
      expect(html).not.toContain("Intent");
    });
  });

  describe("actor swim lane", () => {
    it("shows the lane label and principal badge at reading zoom", () => {
      flowMock.zoom = 1;
      const html = render(
        <BpmnLaneNode data={{ lane: actorLane, height: 140, width: 800, labelWidth: 140 }} />,
      );
      expect(html).toContain("Hiring Manager");
      expect(html).toContain("Principal");
    });

    it("drops the lane label and badges when zoomed out past the LOD threshold", () => {
      flowMock.zoom = 0.3;
      const html = render(
        <BpmnLaneNode data={{ lane: actorLane, height: 140, width: 800, labelWidth: 140 }} />,
      );
      // The lane collapses to a plain tinted band — no label, no
      // principal/lifecycle pills.
      expect(html).not.toContain("Hiring Manager");
      expect(html).not.toContain("Principal");
    });
  });
});
