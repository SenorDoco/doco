import { describe, expect, it } from "vitest";
import { graphRenderBudgetFor, shouldPublishViewport } from "../graph-render-performance";

describe("graph render performance", () => {
  it("steps down the render window once Graph reaches 100 nodes", () => {
    const budget = graphRenderBudgetFor({
      perspective: "graph",
      nodeCount: 100,
      linkCount: 100,
    });

    expect(budget.nodeBudget).toBeLessThanOrEqual(72);
    expect(budget.minFirstDegree).toBeLessThanOrEqual(36);
    expect(budget.edgeBudget).toBeLessThanOrEqual(240);
    expect(budget.placeholderStubBudget).toBeLessThanOrEqual(80);
  });

  it("keeps small Graph canvases complete", () => {
    const budget = graphRenderBudgetFor({
      perspective: "graph",
      nodeCount: 40,
      linkCount: 60,
    });

    expect(budget.nodeBudget).toBe(100);
    expect(budget.minFirstDegree).toBe(50);
    expect(budget.edgeBudget).toBe(700);
    expect(budget.placeholderStubBudget).toBe(120);
  });

  it("uses the same dense budget for BPMN at the 100-node threshold", () => {
    const budget = graphRenderBudgetFor({
      perspective: "bpmn",
      nodeCount: 100,
      linkCount: 100,
    });

    expect(budget.nodeBudget).toBeLessThanOrEqual(72);
    expect(budget.minFirstDegree).toBeLessThanOrEqual(36);
    expect(budget.edgeBudget).toBeLessThanOrEqual(240);
    expect(budget.placeholderStubBudget).toBeLessThanOrEqual(80);
  });

  it("ignores tiny viewport changes that would otherwise re-render on every pan event", () => {
    expect(
      shouldPublishViewport({ x: 120, y: -80, zoom: 0.6 }, { x: 122, y: -83, zoom: 0.603 }),
    ).toBe(false);

    expect(
      shouldPublishViewport({ x: 120, y: -80, zoom: 0.6 }, { x: 132, y: -80, zoom: 0.6 }),
    ).toBe(true);
  });
});
