import type { SemanticQuery } from "@doco/db";
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
import type { SlackPerspectiveData } from "./slack-mirror-read.server";
import { loadSlackPerspective } from "./slack-mirror-read.server";

type QueryClient = {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

export interface DocoHomePerspectiveBudget {
  /**
   * Maximum graph-like nodes serialized for a single perspective load.
   * This is a page-level budget, not a renderer preference.
   */
  nodeLimit: number;
}

export const DEFAULT_DOCO_HOME_PERSPECTIVE_BUDGET: DocoHomePerspectiveBudget = {
  nodeLimit: 375,
};

export interface DocoHomePerspectiveData {
  graph: OverviewGraphData | null;
  pageRanks: Record<string, number>;
  processGraph: ProcessGraphData | null;
  orgTreeData: OrgTreeData | null;
  slaData: SlaPerspectiveData | null;
  glossaryData: GlossaryPerspectiveData | null;
  pullRequestsData: PullRequestsPerspectiveData | null;
  slackData: SlackPerspectiveData | null;
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
     * The Pull requests perspective's URL state: the selected lifecycle stages
     * (undefined, or every stage, loads them all; a subset narrows the list
     * server-side) and how many of the latest to show.
     */
    pullRequests?: { lifecycles?: string[]; limit?: number };
    /** The Slack perspective's URL state: channel, older-page cursor, search, channels shown. */
    slack?: {
      channelId?: string | null;
      before?: string | null;
      query?: string | null;
      channelLimit?: number;
    };
    /** The embedded search query, when the Slack perspective is searching. */
    semantic?: SemanticQuery | null;
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
    slackData: null,
  };
  const perspectiveWindow =
    args.activeKind === "pull-requests" ||
    args.activeKind === "process" ||
    args.activeKind === "slack"
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
        pullRequestsData: await loadPullRequestsPerspective(c, args.docoId, args.pullRequests),
      };
    case "slack":
      return {
        ...empty,
        slackData: await loadSlackPerspective(c, args.docoId, {
          ...args.slack,
          semantic: args.semantic ?? null,
        }),
      };
    default: {
      const exhaustive: never = args.activeKind;
      throw new Error(`Unhandled perspective kind: ${exhaustive}`);
    }
  }
}

function perspectiveWindowSpecFor(
  kind: Exclude<PerspectiveKind, "pull-requests" | "slack">,
): PerspectiveWindowSpec {
  if (kind === "list") return PERSPECTIVE_WINDOW_SPECS.graph;
  return PERSPECTIVE_WINDOW_SPECS[kind];
}
