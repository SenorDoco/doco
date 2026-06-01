import type { OverviewGraphData } from "~/components/overview-graph";
import type { ApprovalPerspectiveData } from "./approval-perspective.server";
import { loadApprovalPerspectiveData } from "./approval-perspective.server";
import type { BpmnGraphData } from "./bpmn-perspective.server";
import { loadBpmnGraph } from "./bpmn-perspective.server";
import { loadOverviewGraph } from "./full-graph.server";
import type { GlossaryPerspectiveData } from "./glossary-perspective.server";
import { loadGlossaryPerspectiveData } from "./glossary-perspective.server";
import type { OrgTreeData } from "./org-tree-perspective.server";
import { loadOrgTreeData } from "./org-tree-perspective.server";
import { pageRank } from "./pagerank";
import type { PerspectiveWindowSpec } from "./perspective-window.server";
import { PERSPECTIVE_WINDOW_SPECS, selectPerspectiveWindow } from "./perspective-window.server";
import type { PerspectiveKind } from "./perspectives.server";
import type { PullRequestsPerspectiveData } from "./pull-requests-perspective.server";
import { loadPullRequestsPerspective } from "./pull-requests-perspective.server";
import type { SlaPerspectiveData } from "./sla-perspective.server";
import { loadSlaPerspectiveData } from "./sla-perspective.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface DocoHomePerspectiveBudget {
  /**
   * Maximum graph-like nodes serialized for a single perspective load.
   * This is a page-level budget, not a renderer preference.
   */
  nodeLimit: number;
  /** Maximum non-graph rows serialized for list-like perspectives. */
  rowLimit: number;
}

export const DEFAULT_DOCO_HOME_PERSPECTIVE_BUDGET: DocoHomePerspectiveBudget = {
  nodeLimit: 750,
  rowLimit: 500,
};

export interface DocoHomePerspectiveData {
  graph: OverviewGraphData | null;
  pageRanks: Record<string, number>;
  bpmnGraph: BpmnGraphData | null;
  orgTreeData: OrgTreeData | null;
  slaData: SlaPerspectiveData | null;
  approvalData: ApprovalPerspectiveData | null;
  glossaryData: GlossaryPerspectiveData | null;
  pullRequestsData: PullRequestsPerspectiveData | null;
}

export async function loadDocoHomePerspectiveData(
  c: QueryClient,
  args: {
    activeKind: PerspectiveKind;
    docoId: string;
    handle: string;
    focusNodeId: string | null | undefined;
    budget?: DocoHomePerspectiveBudget;
  },
): Promise<DocoHomePerspectiveData> {
  const budget = args.budget ?? DEFAULT_DOCO_HOME_PERSPECTIVE_BUDGET;
  const empty: DocoHomePerspectiveData = {
    graph: null,
    pageRanks: {},
    bpmnGraph: null,
    orgTreeData: null,
    slaData: null,
    approvalData: null,
    glossaryData: null,
    pullRequestsData: null,
  };
  const perspectiveWindow =
    args.activeKind === "pull-requests"
      ? null
      : await selectPerspectiveWindow(c, {
          docoId: args.docoId,
          explicitFocusNodeId: args.focusNodeId ?? null,
          limit: budget.nodeLimit,
          spec: perspectiveWindowSpecFor(args.activeKind),
        });
  const focusNodeId = perspectiveWindow?.focusNodeId ?? args.focusNodeId ?? undefined;

  switch (args.activeKind) {
    case "graph":
    case "list": {
      const graph = await loadOverviewGraph(c, args.docoId, {
        handle: args.handle,
        ...(focusNodeId ? { centerId: focusNodeId } : {}),
        limit: budget.nodeLimit,
        window: perspectiveWindow ?? undefined,
      });
      const pageRankMap = pageRank(graph.nodes, graph.links);
      return {
        ...empty,
        graph,
        pageRanks: Object.fromEntries(pageRankMap.entries()),
      };
    }
    case "bpmn":
      return {
        ...empty,
        bpmnGraph: await loadBpmnGraph(c, args.docoId, {
          focusId: focusNodeId,
          handle: args.handle,
          nodeLimit: budget.nodeLimit,
          window: perspectiveWindow ?? undefined,
        }),
      };
    case "org-tree":
      return {
        ...empty,
        orgTreeData: await loadOrgTreeData(c, args.docoId, args.handle, {
          limit: budget.nodeLimit,
          window: perspectiveWindow ?? undefined,
        }),
      };
    case "sla":
      return {
        ...empty,
        slaData: await loadSlaPerspectiveData(c, args.docoId, args.handle, {
          limit: budget.nodeLimit,
          window: perspectiveWindow ?? undefined,
        }),
      };
    case "approval":
      return {
        ...empty,
        approvalData: await loadApprovalPerspectiveData(c, args.docoId, args.handle, {
          limit: budget.nodeLimit,
          window: perspectiveWindow ?? undefined,
        }),
      };
    case "glossary":
      return {
        ...empty,
        glossaryData: await loadGlossaryPerspectiveData(c, args.docoId, args.handle, {
          limit: budget.nodeLimit,
          window: perspectiveWindow ?? undefined,
        }),
      };
    case "pull-requests":
      return {
        ...empty,
        pullRequestsData: await loadPullRequestsPerspective(c, args.docoId, {
          limit: budget.rowLimit,
        }),
      };
    default: {
      const exhaustive: never = args.activeKind;
      throw new Error(`Unhandled perspective kind: ${exhaustive}`);
    }
  }
}

function perspectiveWindowSpecFor(
  kind: Exclude<PerspectiveKind, "pull-requests">,
): PerspectiveWindowSpec {
  if (kind === "list") return PERSPECTIVE_WINDOW_SPECS.graph;
  return PERSPECTIVE_WINDOW_SPECS[kind];
}
