import { describe, expect, it, vi } from "vitest";
import {
  clickedExternalNeighbour,
  openCanvasNode,
} from "~/components/perspectives/process-perspective";
import type { ProcessNode } from "~/lib/process-perspective.server";

const node = (id: string, overrides: Partial<ProcessNode> = {}): ProcessNode => ({
  id,
  entity_type: "action",
  name: id,
  lifecycle: "active",
  created_at: null,
  href: `/doco/action/${id}`,
  shape: "task",
  laneId: "lane_1",
  pool_id: "pool:p1",
  ...overrides,
});

function handlers() {
  return {
    setHomeMode: vi.fn(),
    setExpandedProcessId: vi.fn(),
    onCenterChange: vi.fn(),
    onNodeClick: vi.fn(),
    navigate: vi.fn(),
  };
}

describe("openCanvasNode", () => {
  it("viewing a subprocess expands its OWN pool AND opens its node dialog", () => {
    const subprocess = node("sub_1");
    const h = handlers();
    openCanvasNode(subprocess, { expandSubprocess: true }, h);
    // "open the sub-process" — its own pool frames the canvas…
    expect(h.setExpandedProcessId).toHaveBeenCalledWith("sub_1");
    expect(h.onCenterChange).toHaveBeenCalledWith("sub_1");
    // …and "open the node dialog as usual" — exactly like any node click.
    expect(h.onNodeClick).toHaveBeenCalledWith(subprocess);
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.setHomeMode).toHaveBeenCalledWith(false);
  });

  it("a plain node click collapses to the parent pool but still opens the dialog", () => {
    const member = node("member_1");
    const h = handlers();
    openCanvasNode(member, { expandSubprocess: false }, h);
    expect(h.setExpandedProcessId).toHaveBeenCalledWith(null);
    expect(h.onCenterChange).toHaveBeenCalledWith("member_1");
    expect(h.onNodeClick).toHaveBeenCalledWith(member);
  });

  it("falls back to navigation when no dialog handler is wired", () => {
    const member = node("member_2");
    const h = { ...handlers(), onNodeClick: undefined };
    openCanvasNode(member, { expandSubprocess: false }, h);
    expect(h.navigate).toHaveBeenCalledWith("/doco/action/member_2");
  });
});

describe("clickedExternalNeighbour", () => {
  it("resolves an external-neighbour box to the cross-pool node it stands for", () => {
    const external = node("q1", { pool_id: "pool:other" });
    expect(
      clickedExternalNeighbour({
        id: "external:entry:q1:pool:action_p",
        data: { node: external },
      }),
    ).toBe(external);
  });

  it("returns null for an ordinary in-pool flow node", () => {
    expect(
      clickedExternalNeighbour({ id: "member_1", data: { node: node("member_1") } }),
    ).toBeNull();
  });

  it("returns null for an external id whose data carries no node", () => {
    expect(clickedExternalNeighbour({ id: "external:entry:q1:pool:p" })).toBeNull();
  });
});
