import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PerspectiveKind } from "../perspectives.server";

const mocks = vi.hoisted(() => ({
  loadApprovalPerspectiveData: vi.fn(),
  loadBpmnGraph: vi.fn(),
  loadGlossaryPerspectiveData: vi.fn(),
  loadOrgTreeData: vi.fn(),
  loadOverviewGraph: vi.fn(),
  loadPullRequestsPerspective: vi.fn(),
  loadSlaPerspectiveData: vi.fn(),
  pageRank: vi.fn(),
}));

vi.mock("../approval-perspective.server", () => ({
  loadApprovalPerspectiveData: mocks.loadApprovalPerspectiveData,
}));
vi.mock("../bpmn-perspective.server", () => ({ loadBpmnGraph: mocks.loadBpmnGraph }));
vi.mock("../full-graph.server", () => ({ loadOverviewGraph: mocks.loadOverviewGraph }));
vi.mock("../glossary-perspective.server", () => ({
  loadGlossaryPerspectiveData: mocks.loadGlossaryPerspectiveData,
}));
vi.mock("../org-tree-perspective.server", () => ({ loadOrgTreeData: mocks.loadOrgTreeData }));
vi.mock("../pull-requests-perspective.server", () => ({
  loadPullRequestsPerspective: mocks.loadPullRequestsPerspective,
}));
vi.mock("../sla-perspective.server", () => ({
  loadSlaPerspectiveData: mocks.loadSlaPerspectiveData,
}));
vi.mock("../pagerank", () => ({ pageRank: mocks.pageRank }));

import {
  DEFAULT_DOCO_HOME_PERSPECTIVE_BUDGET,
  loadDocoHomePerspectiveData,
} from "../doco-home-perspective.server";

const ALL_KINDS: PerspectiveKind[] = [
  "graph",
  "list",
  "bpmn",
  "org-tree",
  "sla",
  "approval",
  "glossary",
  "pull-requests",
];

const client = { query: vi.fn() };

describe("loadDocoHomePerspectiveData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadOverviewGraph.mockResolvedValue({
      centerId: "decision_1",
      nodes: [{ id: "decision_1" }],
      links: [],
      detailUrl: "/graph-node-details.json",
    });
    mocks.pageRank.mockReturnValue(new Map([["decision_1", 0.5]]));
    mocks.loadBpmnGraph.mockResolvedValue({ pools: [], lanes: [], nodes: [], links: [] });
    mocks.loadOrgTreeData.mockResolvedValue({ nodes: [] });
    mocks.loadSlaPerspectiveData.mockResolvedValue({ commitments: [], stats: {} });
    mocks.loadApprovalPerspectiveData.mockResolvedValue({ nodes: [] });
    mocks.loadGlossaryPerspectiveData.mockResolvedValue({
      groups: [],
      letters: [],
      stats: { entries: 0, defined: 0, withAliases: 0, drafting: 0 },
    });
    mocks.loadPullRequestsPerspective.mockResolvedValue({
      connected: true,
      groups: [],
      loadedCount: 0,
      hasMore: false,
    });
  });

  it.each(ALL_KINDS)("applies the default page budget to %s", async (kind) => {
    await loadDocoHomePerspectiveData(client, {
      activeKind: kind,
      docoId: "doco_1",
      handle: "acme",
      focusNodeId: "decision_focus",
    });

    const budget = DEFAULT_DOCO_HOME_PERSPECTIVE_BUDGET;
    if (kind === "graph" || kind === "list") {
      expect(mocks.loadOverviewGraph).toHaveBeenCalledWith(client, "doco_1", {
        handle: "acme",
        centerId: "decision_focus",
        limit: budget.nodeLimit,
      });
      return;
    }
    expect(mocks.loadOverviewGraph).not.toHaveBeenCalled();

    if (kind === "bpmn") {
      expect(mocks.loadBpmnGraph).toHaveBeenCalledWith(client, "doco_1", {
        focusId: "decision_focus",
        handle: "acme",
        nodeLimit: budget.nodeLimit,
      });
    } else if (kind === "pull-requests") {
      expect(mocks.loadPullRequestsPerspective).toHaveBeenCalledWith(client, "doco_1", {
        limit: budget.rowLimit,
      });
    } else if (kind === "org-tree") {
      expect(mocks.loadOrgTreeData).toHaveBeenCalledWith(client, "doco_1", "acme", {
        limit: budget.nodeLimit,
      });
    } else if (kind === "sla") {
      expect(mocks.loadSlaPerspectiveData).toHaveBeenCalledWith(client, "doco_1", "acme", {
        limit: budget.nodeLimit,
      });
    } else if (kind === "approval") {
      expect(mocks.loadApprovalPerspectiveData).toHaveBeenCalledWith(client, "doco_1", "acme", {
        limit: budget.nodeLimit,
      });
    } else {
      expect(mocks.loadGlossaryPerspectiveData).toHaveBeenCalledWith(client, "doco_1", "acme", {
        limit: budget.nodeLimit,
      });
    }
  });

  it("returns graph page ranks only for graph-backed perspectives", async () => {
    const data = await loadDocoHomePerspectiveData(client, {
      activeKind: "list",
      docoId: "doco_1",
      handle: "acme",
      focusNodeId: null,
    });

    expect(data.graph?.nodes).toEqual([{ id: "decision_1" }]);
    expect(data.pageRanks).toEqual({ decision_1: 0.5 });
  });
});
