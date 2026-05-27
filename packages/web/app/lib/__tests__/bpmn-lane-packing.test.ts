import { describe, expect, it } from "vitest";
import { bpmnLaneColumnKey, packBpmnLaneColumns } from "../bpmn-lane-packing";

describe("packBpmnLaneColumns", () => {
  it("stacks same-lane nodes that share a sequence depth", () => {
    const depths = new Map([
      ["gateway", 1],
      ["branch_a", 2],
      ["branch_b", 2],
    ]);

    const packed = packBpmnLaneColumns(
      ["lane:system"],
      [
        { id: "gateway", laneId: "lane:system", created_at: "2026-05-26T00:00:00.000Z" },
        { id: "branch_b", laneId: "lane:system", created_at: "2026-05-26T00:02:00.000Z" },
        { id: "branch_a", laneId: "lane:system", created_at: "2026-05-26T00:01:00.000Z" },
      ],
      depths,
    );

    expect(packed.columnByNode.get("branch_a")).toBe(2);
    expect(packed.columnByNode.get("branch_b")).toBe(2);
    expect(packed.stackIndexByNode.get("branch_a")).toBe(0);
    expect(packed.stackIndexByNode.get("branch_b")).toBe(1);
    expect(packed.maxColumn).toBe(2);
    expect(
      packed.laneColumnStacks.get(bpmnLaneColumnKey("lane:system", 2))?.map((n) => n.id),
    ).toEqual(["branch_a", "branch_b"]);
  });

  it("keeps later sequence depths to the right instead of stacking them", () => {
    const depths = new Map([
      ["first", 0],
      ["second", 1],
      ["third", 2],
    ]);

    const packed = packBpmnLaneColumns(
      ["lane:actor"],
      [
        { id: "third", laneId: "lane:actor" },
        { id: "first", laneId: "lane:actor" },
        { id: "second", laneId: "lane:actor" },
      ],
      depths,
    );

    expect(packed.orderedByLane.get("lane:actor")?.map((n) => n.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(new Set(Array.from(packed.columnByNode.values()))).toEqual(new Set([0, 1, 2]));
  });
});
