import { describe, expect, it } from "vitest";
import {
  BOUNDARY_NEIGHBOUR_GAP,
  boundaryNeighbourX,
} from "~/components/perspectives/process-perspective";

// A focal pool laid out from LANE_LEFT_INSET (16) spanning `laneWidth` px.
// Out-of-pool sequence-flow neighbours (nodes in OTHER pools that connect via
// `flows_to`) render as boxes hugging the pool: entries to the LEFT, exits to
// the RIGHT. The empty band between each box and the pool edge is the
// separation under test here.
const poolLeft = 16; // LANE_LEFT_INSET
const laneWidth = 300;
const poolRight = poolLeft + laneWidth;
const nodeWidth = 140;

function neighbour(direction: "entry" | "exit"): { left: number; right: number } {
  const x = boundaryNeighbourX({
    direction,
    laneLeftInset: poolLeft,
    laneWidth,
    nodeWidth,
    gap: BOUNDARY_NEIGHBOUR_GAP,
  });
  return { left: x, right: x + nodeWidth };
}

describe("out-of-pool neighbour separation", () => {
  it("hangs an entry (left) box the full gap clear of the pool's left edge", () => {
    expect(poolLeft - neighbour("entry").right).toBe(BOUNDARY_NEIGHBOUR_GAP);
  });

  it("hangs an exit (right) box the full gap clear of the pool's right edge", () => {
    expect(neighbour("exit").left - poolRight).toBe(BOUNDARY_NEIGHBOUR_GAP);
  });

  it("keeps the left and right separations symmetric", () => {
    expect(poolLeft - neighbour("entry").right).toBe(neighbour("exit").left - poolRight);
  });

  it("doubles the out-of-pool separation to 80px on both sides", () => {
    expect(BOUNDARY_NEIGHBOUR_GAP).toBe(80);
  });
});
