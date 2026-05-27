import { describe, expect, it } from "vitest";
import { type BpmnEdgeBox, bpmnEdgePath, routeBpmnSequenceEdge } from "../bpmn-edge-routing";

const lanes = new Map([
  ["lane:a", { id: "lane:a", top: 0, bottom: 120 }],
  ["lane:b", { id: "lane:b", top: 120, bottom: 240 }],
  ["lane:c", { id: "lane:c", top: 240, bottom: 360 }],
]);

function box(id: string, laneId: string, left: number, top: number): BpmnEdgeBox {
  return { id, laneId, left, right: left + 100, top, bottom: top + 60 };
}

describe("routeBpmnSequenceEdge", () => {
  it("routes cross-lane edges through a clear vertical transfer gutter", () => {
    const source = box("source", "lane:a", 100, 30);
    const target = box("target", "lane:c", 420, 270);
    const obstacle = box("obstacle", "lane:b", 245, 150);

    const points = routeBpmnSequenceEdge({
      source,
      target,
      obstacles: [source, target, obstacle],
      lanes,
    });

    const verticalSegments = segments(points).filter((segment) => segment.x1 === segment.x2);
    expect(verticalSegments.length).toBeGreaterThan(0);
    expect(
      verticalSegments.some(
        (segment) =>
          segment.x1 >= obstacle.left - 10 &&
          segment.x1 <= obstacle.right + 10 &&
          overlaps(segment.y1, segment.y2, obstacle.top - 10, obstacle.bottom + 10),
      ),
    ).toBe(false);
  });

  it("routes backward edges outside the node columns instead of through cards", () => {
    const source = box("source", "lane:b", 520, 150);
    const target = box("target", "lane:a", 120, 30);

    const points = routeBpmnSequenceEdge({
      source,
      target,
      obstacles: [source, target],
      lanes,
    });

    expect(Math.max(...points.map((point) => point.x))).toBeGreaterThan(source.right);
  });

  it("turns route points into a rounded SVG path", () => {
    const path = bpmnEdgePath([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
    ]);

    expect(path).toMatch(/^M 0 0/);
    expect(path).toContain(" Q ");
    expect(path).toMatch(/L 40 40$/);
  });
});

function segments(points: ReturnType<typeof routeBpmnSequenceEdge>) {
  const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (let i = 1; i < points.length; i++) {
    out.push({
      x1: points[i - 1].x,
      y1: points[i - 1].y,
      x2: points[i].x,
      y2: points[i].y,
    });
  }
  return out;
}

function overlaps(a1: number, a2: number, b1: number, b2: number): boolean {
  return (
    Math.max(Math.min(a1, a2), Math.min(b1, b2)) <= Math.min(Math.max(a1, a2), Math.max(b1, b2))
  );
}
