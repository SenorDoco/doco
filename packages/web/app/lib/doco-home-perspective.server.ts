import type { OverviewGraphData } from "~/components/overview-graph";
import { loadOverviewGraph } from "./full-graph.server";
import type { GlossaryPerspectiveData } from "./glossary-perspective.server";
import { loadGlossaryPerspectiveData } from "./glossary-perspective.server";
import type { OrgTreeData } from "./org-tree-perspective.server";
import { loadOrgTreeData } from "./org-tree-perspective.server";
import { pageRank } from "./pagerank";
import type { PerspectiveWindowSpec } from "./perspective-window.server";
import { PERSPECTIVE_WINDOW_SPECS, selectPerspectiveWindow } from "./perspective-window.server";
import type { PerspectiveKind } from "./perspectives.server";
import type { ProcessGraphData } from "./process-perspective.server";
import { loadProcessGraph } from "./process-perspective.server";
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
  nodeLimit: 375,
  rowLimit: 500,
};

export interface DocoHomePerspectiveData {
  graph: OverviewGraphData | null;
  pageRanks: Record<string, number>;
  processGraph: ProcessGraphData | null;
  orgTreeData: OrgTreeData | null;
  slaData: SlaPerspectiveData | null;
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
    /**
     * Selected PR lifecycle stages for the Pull requests perspective. Undefined
     * (or every stage) loads the full list; a subset narrows it server-side.
     */
    pullRequestLifecycles?: string[];
  },
): Promise<DocoHomePerspectiveData> {
  const budget = args.budget ?? DEFAULT_DOCO_HOME_PERSPECTIVE_BUDGET;
  const empty: DocoHomePerspectiveData = {
    graph: null,
    pageRanks: {},
    processGraph: null,
    orgTreeData: null,
    slaData: null,
    glossaryData: null,
    pullRequestsData: null,
  };
  const perspectiveWindow =
    args.activeKind === "pull-requests" || args.activeKind === "process"
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
    case "process":
      // BPMN renders the whole process: no node budget and no render-window.
      // Other perspectives cap to a ranked subset on large Docos, but the BPMN
      // canvas pans/zooms over every step, so windowing or limiting it would
      // silently drop nodes the author expects to see (e.g. a state that
      // serves an intent disappearing from its pool's milestone band).
      return {
        ...empty,
        processGraph: await loadProcessGraph(c, args.docoId, {
          focusId: focusNodeId,
          handle: args.handle,
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
          lifecycles: args.pullRequestLifecycles,
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
