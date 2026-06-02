import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PerspectiveKind } from "../perspectives.server";

const mocks = vi.hoisted(() => ({
  loadBpmnGraph: vi.fn(),
  loadGlossaryPerspectiveData: vi.fn(),
  loadOrgTreeData: vi.fn(),
  loadOverviewGraph: vi.fn(),
  loadPullRequestsPerspective: vi.fn(),
  loadSlaPerspectiveData: vi.fn(),
  pageRank: vi.fn(),
  selectPerspectiveWindow: vi.fn(),
  window: {
    focusNodeId: "decision_window",
    nodeIds: ["decision_window"],
    reasonByNodeId: {},
    totalEligibleByType: {},
    omittedCountsByType: {},
    hasMore: false,
  },
  specs: {
    graph: { key: "graph" },
    bpmn: { key: "bpmn" },
    "org-tree": { key: "org-tree" },
    sla: { key: "sla" },
    glossary: { key: "glossary" },
  },
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
vi.mock("../perspective-window.server", () => ({
  PERSPECTIVE_WINDOW_SPECS: mocks.specs,
  selectPerspectiveWindow: mocks.selectPerspectiveWindow,
}));

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
    mocks.selectPerspectiveWindow.mockResolvedValue(mocks.window);
  });

  it.each(ALL_KINDS)("applies the default page budget to %s", async (kind) => {
    await loadDocoHomePerspectiveData(client, {
      activeKind: kind,
      docoId: "doco_1",
      handle: "acme",
      focusNodeId: "decision_focus",
    });

    const budget = DEFAULT_DOCO_HOME_PERSPECTIVE_BUDGET;
    const expectedSpec =
      kind === "list" ? mocks.specs.graph : mocks.specs[kind as keyof typeof mocks.specs];
    if (kind === "pull-requests") {
      expect(mocks.selectPerspectiveWindow).not.toHaveBeenCalled();
    } else {
      expect(mocks.selectPerspectiveWindow).toHaveBeenCalledWith(client, {
        docoId: "doco_1",
        explicitFocusNodeId: "decision_focus",
        limit: budget.nodeLimit,
        spec: expectedSpec,
      });
    }

    if (kind === "graph" || kind === "list") {
      expect(mocks.loadOverviewGraph).toHaveBeenCalledWith(client, "doco_1", {
        handle: "acme",
        centerId: "decision_window",
        limit: budget.nodeLimit,
        window: mocks.window,
      });
      return;
    }
    expect(mocks.loadOverviewGraph).not.toHaveBeenCalled();

    if (kind === "bpmn") {
      expect(mocks.loadBpmnGraph).toHaveBeenCalledWith(client, "doco_1", {
        focusId: "decision_window",
        handle: "acme",
        nodeLimit: budget.nodeLimit,
        window: mocks.window,
      });
    } else if (kind === "pull-requests") {
      expect(mocks.loadPullRequestsPerspective).toHaveBeenCalledWith(client, "doco_1", {
        limit: budget.rowLimit,
      });
    } else if (kind === "org-tree") {
      expect(mocks.loadOrgTreeData).toHaveBeenCalledWith(client, "doco_1", "acme", {
        limit: budget.nodeLimit,
        window: mocks.window,
      });
    } else if (kind === "sla") {
      expect(mocks.loadSlaPerspectiveData).toHaveBeenCalledWith(client, "doco_1", "acme", {
        limit: budget.nodeLimit,
        window: mocks.window,
      });
    } else {
      expect(mocks.loadGlossaryPerspectiveData).toHaveBeenCalledWith(client, "doco_1", "acme", {
        limit: budget.nodeLimit,
        window: mocks.window,
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
