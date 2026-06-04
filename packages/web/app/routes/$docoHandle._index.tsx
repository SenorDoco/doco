import { withClient } from "@doco/db";
import { normalizeNodeType } from "@doco/shared";
import { ArrowRight } from "lucide-react";
// Per-Doco home — bare title up top, then the search input, activity heatmap,
// node overview, and latest activity feed in a single content column.
//
// The feed renders one line per recent audit event in the same family as
// agent footer lines: `<op-icon> <Type> <verb>: <readable text>`. Lifecycle
// transitions include their old → new value so state changes show up in
// the feed instead of disappearing behind the entity's original created_at.
//
// Live feed (ADR-089): re-fetch every 5s so new entities show up
// without a manual refresh. React Router 7's useRevalidator re-runs the
// loader. We only poll when the tab is visible to avoid burning cycles
// on idle tabs.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useRevalidator, useSearchParams } from "react-router";
import { parse as parseYaml } from "yaml";
import { ActivityFeedLine, type ActivityFeedLineItem } from "~/components/activity-feed-line";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { EdgeDialog } from "~/components/edge-dialog";
import { GithubIntegrationCard } from "~/components/github-integration-card";
import {
  LIFECYCLE_ORDER,
  initialVisibleLifecycles,
  newlyVisibleLifecycles,
} from "~/components/lifecycle-filter";
import { NodeDialog } from "~/components/node-dialog";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { NodesOverviewCard, type NodesOverviewSection } from "~/components/nodes-overview-card";
import {
  OverviewGraph,
  type OverviewGraphData,
  type OverviewGraphLink,
  type OverviewGraphNode,
} from "~/components/overview-graph";
import { PageHeader } from "~/components/page-header";
import { PerspectiveFrame } from "~/components/perspective-frame";
import { PerspectiveSearchOverlay } from "~/components/perspective-search-overlay";
import { PerspectiveTabs } from "~/components/perspective-tabs";
import { BpmnPerspective } from "~/components/perspectives/bpmn-perspective";
import { GlossaryPerspective } from "~/components/perspectives/glossary-perspective";
import { ListPerspective } from "~/components/perspectives/list-perspective";
import { OrgTreePerspective } from "~/components/perspectives/org-tree-perspective";
import { PullRequestsPerspective } from "~/components/perspectives/pull-requests-perspective";
import { SlaPerspective } from "~/components/perspectives/sla-perspective";
import { SiteHeader } from "~/components/site-header";
import { docoPath } from "~/lib/db.server";
import { canAdminDoco, canWriteDoco, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadDocoHomePerspectiveData } from "~/lib/doco-home-perspective.server";
import { type EdgeDialogDetail, loadEdgeDialogDetail } from "~/lib/edge-detail.server";
import { highestRankedNodeId } from "~/lib/focused-render-selection";
import { githubIntegrationStatus } from "~/lib/github-connection.server";
import { loadHostConfig } from "~/lib/host.server";
import { lifecycleColor } from "~/lib/node-colors";
import {
  type LifecycleStage,
  type NodeDialogDetail,
  isGraphNodeType,
  loadNodeDialogDetail,
} from "~/lib/node-detail.server";
import {
  type DialogHistoryAction,
  edgeDialogHistoryState,
  entityTypeFromPathname,
  nodeDialogHistoryState,
  readDialogHistoryState,
} from "~/lib/perspective-dialog-history";
import { effectivePerspectiveFocusId, perspectiveCenterId } from "~/lib/perspective-focus";
import {
  ensureDefaultsAttached,
  listAvailablePerspectives,
  listPerspectivesForDoco,
  resolveActivePerspective,
} from "~/lib/perspectives.server";
import {
  PR_LIFECYCLE_ORDER,
  parsePrLifecycles,
  pullRequestLabel,
  togglePrLifecycleParam,
  visiblePrLifecycles,
} from "~/lib/pull-requests";
import { computeFilterFacets } from "~/lib/search-filters.server";
import { timeAgo } from "~/lib/time-ago";
import { useFullscreen } from "~/lib/use-fullscreen";

const FEED_LIMIT = 20;
const HEATMAP_WEEKS = 52;
const TOP_CONTRIBUTORS_LIMIT = 10;
// The side panel — the activity column, or the node dialog — sits to the
// RIGHT of the perspective only when the two fit side by side: the
// perspective and the panel together (excluding the gap between them) must
// total at least this width. Below it the activity column is hidden and the
// node dialog floats on top of the perspective instead. One flag governs
// both, so the column and the right-hand dialog appear under the same rule.
const SIDE_PANEL_MIN_COMBINED_WIDTH = 768;
// Matches the grid's gap-6 between the perspective and the side panel.
const RIGHT_COLUMN_GRID_GAP = 24;

interface FeedItem extends ActivityFeedLineItem {
  event_id: string;
}

interface TopContributor {
  userId: string;
  username: string;
  lastAt: string;
  eventCount: number;
}

const NODE_TYPE_LABELS: Record<string, string> = {
  decision: "Decisions",
  action: "Actions",
  intent: "Intents",
  rule: "Rules",
  policy: "Policies",
  eval: "Evals",
  reference: "References",
  idea: "Ideas",
};

function nodeTypeLabel(type: string): string {
  return (
    NODE_TYPE_LABELS[type] ??
    `${type
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")}s`
  );
}

function edgeTypeLabel(type: string): string {
  return type
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: {
    docoHandle?: string;
    docoId?: string;
    type?: string;
    id?: string;
    edgeKey?: string;
  };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { handle } = ctx;
  const me = ctx.me;
  const dir = docoPath(handle);
  const requestedEntityType =
    typeof params.type === "string" ? normalizeNodeType(params.type) : null;
  const requestedNode =
    requestedEntityType && typeof params.id === "string"
      ? { entityType: requestedEntityType, id: params.id }
      : null;
  const requestedEdgeId = typeof params.edgeKey === "string" ? params.edgeKey : null;
  if (requestedNode && !isGraphNodeType(requestedNode.entityType)) {
    throw new Response("Unknown node type", { status: 404 });
  }
  if (typeof params.type === "string" && typeof params.id === "string" && !requestedNode) {
    throw new Response("Unknown node type", { status: 404 });
  }
  return withClient(async (c) => {
    type AuditFeedRow = {
      event_id: string;
      at: Date | string;
      entity_type: string;
      entity_id: string;
      op: string;
      before_json: Record<string, unknown> | null;
      after_json: Record<string, unknown> | null;
    };
    // Activity surfaces (feed, heatmap, contributors) reflect notes
    // activity only — policies are Doco-level metadata with their
    // own surface, and counting their bulk-imported writes here makes
    // a fresh Doco look like work has been captured when none has.
    const rawItems = (
      await c.query<AuditFeedRow>(
        `SELECT event_id, at, entity_type, entity_id, op, before_json, after_json
           FROM audit_events
          WHERE doco_id = $1
            AND entity_type NOT IN ('policy')
          ORDER BY at DESC
          LIMIT $2`,
        [ctx.meta.docoId, FEED_LIMIT],
      )
    ).rows;

    const entityIds = Array.from(new Set(rawItems.map((r) => r.entity_id)));
    const entityById = new Map<string, { label: string | null; lifecycle: string | null }>();
    if (entityIds.length > 0) {
      const entityLabelRows = await c.query<{
        id: string;
        label: string | null;
        lifecycle: string | null;
      }>(
        // All node types live in `nodes`. Labels are the first line of
        // `prose`, except principals (prose='') label on `name`.
        // Policies keep their own tables and their `policy` column.
        `SELECT id,
                CASE WHEN node_type = 'principal' THEN name ELSE split_part(prose, E'\n', 1) END AS label,
                lifecycle
           FROM nodes
          WHERE doco_id = $1 AND id = ANY($2::text[])
            AND node_type IN ('decision', 'intent', 'idea', 'rule', 'action', 'log', 'eval', 'state', 'reference', 'principal')
         UNION ALL SELECT id, COALESCE(NULLIF(data->'predicate'->>'agent_instruction', ''), kind, 'policy') AS label, lifecycle FROM policies WHERE doco_id = $1 AND id = ANY($2::text[])`,
        [ctx.meta.docoId, entityIds],
      );
      for (const row of entityLabelRows.rows) {
        entityById.set(row.id, { label: row.label, lifecycle: row.lifecycle });
      }
    }

    const items: FeedItem[] = rawItems.map((it) => {
      const entity = entityById.get(it.entity_id);
      // Audit events carry prose under the type-named key for nodes
      // and `policy` for policies. The first non-empty line wins.
      const proseKey = it.entity_type;
      return {
        event_id: it.event_id,
        id: it.entity_id,
        entity_type: it.entity_type,
        summary:
          entity?.label ??
          firstLine(stringField(it.after_json, proseKey)) ??
          firstLine(stringField(it.before_json, proseKey)) ??
          stringField(it.after_json, "policy") ??
          stringField(it.before_json, "policy"),
        lifecycle: entity?.lifecycle ?? null,
        at: it.at instanceof Date ? it.at.toISOString() : new Date(String(it.at)).toISOString(),
        op: it.op,
        before: it.before_json,
        after: it.after_json,
      };
    });

    const facets = await computeFilterFacets(c, ctx.meta.docoId);
    const totalNodes = facets.entityType.reduce((sum, t) => sum + t.count, 0);

    const since = new Date();
    since.setDate(since.getDate() - HEATMAP_WEEKS * 7);
    const sinceIso = since.toISOString();
    const activityRows = (
      await c.query<{ day: string; n: string }>(
        // Post-collapse: one scan of `nodes` over the 10 node types
        // (9 prose types + principals; no policies).
        `SELECT day, COUNT(*)::text AS n FROM (
           SELECT to_char(created_at, 'YYYY-MM-DD') AS day
             FROM nodes
            WHERE doco_id = $1
              AND node_type IN ('decision', 'intent', 'idea', 'rule', 'action', 'log', 'eval', 'reference', 'state', 'principal')
         ) t WHERE day >= $2
         GROUP BY day`,
        [ctx.meta.docoId, sinceIso.slice(0, 10)],
      )
    ).rows;
    const byDay: Record<string, number> = {};
    for (const r of activityRows) byDay[r.day] = Number(r.n);

    const contributorRows = (
      await c.query<{
        user_id: string;
        user_name: string;
        last_at: Date | string;
        event_count: string;
      }>(
        `SELECT ae.by_user AS user_id,
                COALESCE(c.github_login, c.email, c.id) AS user_name,
                MAX(ae.at) AS last_at,
                COUNT(*)::text AS event_count
           FROM audit_events ae
           JOIN users c ON c.id = ae.by_user
          WHERE ae.doco_id = $1
            AND ae.entity_type NOT IN ('policy')
          GROUP BY ae.by_user, c.github_login, c.email, c.id
          ORDER BY COUNT(*) DESC, MAX(ae.at) DESC
          LIMIT $2`,
        [ctx.meta.docoId, TOP_CONTRIBUTORS_LIMIT],
      )
    ).rows;
    const topContributors: TopContributor[] = contributorRows.map((r) => ({
      userId: r.user_id,
      username: r.user_name,
      lastAt:
        r.last_at instanceof Date
          ? r.last_at.toISOString()
          : new Date(String(r.last_at)).toISOString(),
      eventCount: Number(r.event_count),
    }));
    const selectedNode = requestedNode
      ? await loadNodeDialogDetail(c, ctx.meta, {
          handle,
          entityType: requestedNode.entityType,
          id: requestedNode.id,
          principalId: me?.id ?? null,
        })
      : null;
    if (requestedNode && !selectedNode) {
      throw new Response(`Node not found: ${requestedNode.id}`, { status: 404 });
    }
    const selectedEdge = requestedEdgeId
      ? await loadEdgeDialogDetail(c, { docoId: ctx.meta.docoId }, { handle, id: requestedEdgeId })
      : null;
    if (requestedEdgeId && !selectedEdge) {
      throw new Response(`Edge not found: ${requestedEdgeId}`, { status: 404 });
    }
    // `?dialog=skip` lets the agent's auto-focus center the graph on
    // a node without popping the detail overlay over the chat. We
    // still load the detail above (the 404 check stays meaningful)
    // and still center the graph on it below — only the dialog state
    // stays empty.
    const skipDialog = new URL(request.url).searchParams.get("dialog") === "skip";
    const dialogNode = skipDialog ? null : selectedNode;
    const dialogEdge = skipDialog ? null : selectedEdge;
    // Visualization perspectives — tabs above the graph body.
    // ensureDefaultsAttached keeps the built-ins present so the UI
    // always has at least one tab.
    await ensureDefaultsAttached(ctx.meta.docoId);
    const [perspectives, availablePerspectives] = await Promise.all([
      listPerspectivesForDoco(ctx.meta.docoId),
      listAvailablePerspectives(),
    ]);
    const requestedSlug = new URL(request.url).searchParams.get("perspective");
    const activePerspective = resolveActivePerspective(perspectives, requestedSlug);
    const activeKind = activePerspective?.kind ?? "graph";
    const canAdminPerspectives = await canWriteDoco(ctx.meta, me?.id ?? null);
    const focusNodeId = selectedNode?.id ?? selectedEdge?.from.id;
    // Pull-requests perspective lifecycle filter: `?pr_lifecycle=queued,active`
    // narrows the list server-side. Absent → the full list (parse → null).
    const pullRequestLifecycles =
      parsePrLifecycles(new URL(request.url).searchParams.get("pr_lifecycle")) ?? undefined;
    const { graph, pageRanks, bpmnGraph, orgTreeData, slaData, glossaryData, pullRequestsData } =
      await loadDocoHomePerspectiveData(c, {
        activeKind,
        docoId: ctx.meta.docoId,
        handle,
        focusNodeId,
        pullRequestLifecycles,
      });

    // Policy count — guidance + node-authoring policies
    // attached to this Doco.
    const policyRow = (
      await c.query<{ n: string }>(
        "SELECT (SELECT COUNT(*) FROM policies WHERE doco_id = $1)::text AS n",
        [ctx.meta.docoId],
      )
    ).rows[0];
    const policyCount = Number(policyRow?.n ?? 0);

    // GitHub-connected Docos get a status box atop the right column; the marker
    // also tells us when the initial PR backfill is still importing old PRs.
    const githubRow = (
      await c.query<{ gh: unknown }>(
        `SELECT data->'github_integration' AS gh FROM docos WHERE id = $1`,
        [ctx.meta.docoId],
      )
    ).rows[0];
    const githubIntegration = githubIntegrationStatus(githubRow?.gh ?? null);

    return {
      items,
      facets,
      totalNodes,
      byDay,
      topContributors,
      handle,
      docoId: ctx.meta.docoId,
      goal: ctx.meta.goal,
      ownerSlug: ctx.canonicalOwnerSlug,
      ownerIsWorkspace: ctx.meta.ownerId.startsWith("workspace_"),
      canInviteUsers: await canAdminDoco(ctx.meta, me?.id ?? null),
      githubIntegration,
      host: await loadHostConfig(),
      me,
      graph,
      policyCount,
      perspectives,
      availablePerspectives,
      activePerspectiveSlug: activePerspective?.slug ?? null,
      activePerspectiveKind: activePerspective?.kind ?? null,
      canAdminPerspectives,
      pageRanks,
      bpmnGraph,
      orgTreeData,
      slaData,
      glossaryData,
      pullRequestsData,
      focusedNodeId: selectedNode?.id ?? null,
      focusedEdgeId: selectedEdge?.id ?? null,
      focusedEdge: selectedEdge,
      selectedNode: dialogNode,
      selectedEdge: dialogEdge,
    };
  });
}

function allNodesSearchPath(handle: string): string {
  const params = new URLSearchParams();
  params.set("entity_type", "*");
  params.set("lifecycle", "*");
  params.set("limit", "500");
  return `/${handle}/search?${params.toString()}`;
}

function nodeTypeSearchPath(handle: string, entityType: string): string {
  const params = new URLSearchParams();
  params.set("entity_type", entityType);
  params.set("lifecycle", "*");
  params.set("limit", "500");
  return `/${handle}/search?${params.toString()}`;
}

function edgeTypeListPath(handle: string, edgeType: string): string {
  const params = new URLSearchParams();
  params.set("edge_type", edgeType);
  return `/${handle}/edges?${params.toString()}`;
}

function withPerspectiveParam(href: string, activeSlug: string): string {
  if (activeSlug === "graph") return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}perspective=${encodeURIComponent(activeSlug)}`;
}

interface NodeDialogState {
  detail: NodeDialogDetail | null;
  loading: boolean;
  error: string | null;
}

interface EdgeDialogState {
  detail: EdgeDialogDetail | null;
  loading: boolean;
  error: string | null;
}

interface EdgeFocusState {
  id: string;
  source: string;
  target: string;
}

function edgeFocusFromDetail(detail: EdgeDialogDetail): EdgeFocusState {
  return {
    id: detail.id,
    source: detail.from.id,
    target: detail.to.id,
  };
}

function graphWithCenter(graph: OverviewGraphData, centerId: string | null): OverviewGraphData {
  const hasCenter = centerId !== null && graph.nodes.some((node) => node.id === centerId);
  return {
    ...graph,
    centerId,
    nodes: graph.nodes.map((node) => ({
      ...node,
      is_center: hasCenter && node.id === centerId,
    })),
  };
}

function graphWithNodeLifecycle(
  graph: OverviewGraphData,
  nodeId: string,
  lifecycle: string,
): OverviewGraphData {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            lifecycle,
          }
        : node,
    ),
  };
}

export function meta({
  data,
  params,
}: {
  data: Awaited<ReturnType<typeof loader>> | undefined;
  params: { docoHandle?: string; docoId?: string };
}) {
  if (data?.selectedNode) {
    const display = data.selectedNode.name ?? data.selectedNode.summary ?? data.selectedNode.id;
    return [{ title: `${display} · ${data.handle} · Doco` }];
  }
  if (data?.focusedEdge) {
    return [{ title: `${data.focusedEdge.edge_type} edge · ${data.handle} · Doco` }];
  }
  return [{ title: `${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function DocoHome({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const {
    items,
    facets,
    totalNodes,
    byDay,
    topContributors,
    handle,
    docoId,
    goal,
    ownerSlug,
    ownerIsWorkspace,
    canInviteUsers,
    githubIntegration,
    me,
    graph,
    policyCount,
    perspectives,
    availablePerspectives,
    activePerspectiveSlug,
    activePerspectiveKind,
    canAdminPerspectives,
    pageRanks,
    bpmnGraph,
    orgTreeData,
    slaData,
    glossaryData,
    pullRequestsData,
    focusedNodeId,
    focusedEdge,
    selectedNode,
    selectedEdge,
  } = loaderData;

  const pageRanksMap = useMemo(() => new Map(Object.entries(pageRanks)), [pageRanks]);
  const defaultFocusId = useMemo(
    () =>
      focusedNodeId ??
      focusedEdge?.from.id ??
      (graph ? highestRankedNodeId(graph.nodes, pageRanksMap) : null) ??
      docoId,
    [focusedNodeId, focusedEdge, graph, pageRanksMap, docoId],
  );
  const graphData = useMemo<OverviewGraphData>(() => {
    const base = graph ?? {
      centerId: defaultFocusId,
      nodes: [],
      links: [],
      detailUrl: null,
    };
    return graphWithCenter({ ...base, pageRanks: pageRanksMap }, defaultFocusId);
  }, [graph, defaultFocusId, pageRanksMap]);
  const activeSlug = activePerspectiveSlug ?? "graph";
  const effectivePerspectiveKind = activePerspectiveKind ?? "graph";
  const routeFocusId = perspectiveCenterId({
    focusedNodeId,
    focusedEdgeFromId: focusedEdge?.from.id ?? null,
  });
  const [graphState, setGraphState] = useState<OverviewGraphData>(() => graphData);
  const [nodeDialog, setNodeDialog] = useState<NodeDialogState | null>(() =>
    selectedNode ? { detail: selectedNode, loading: false, error: null } : null,
  );
  const [edgeDialog, setEdgeDialog] = useState<EdgeDialogState | null>(() =>
    selectedEdge ? { detail: selectedEdge, loading: false, error: null } : null,
  );
  const [edgeFocus, setEdgeFocus] = useState<EdgeFocusState | null>(() =>
    focusedEdge ? edgeFocusFromDetail(focusedEdge) : null,
  );
  const [lifecycleUpdating, setLifecycleUpdating] = useState<LifecycleStage | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const clientDialogOverrideRef = useRef(false);
  // One-shot camera focus the perspectives honor. Opening a node from a
  // side panel — clicking an edge row inside an open node/edge dialog —
  // records it here so the canvas re-centers on that node, exactly as if
  // its URL had been opened from scratch, without re-running the loader.
  // The route focus (a node/edge URL) governs until a panel open sets it.
  const [clientFocusId, setClientFocusId] = useState<string | null>(null);
  const perspectiveFocusId = effectivePerspectiveFocusId(clientFocusId, routeFocusId);

  // While a detail dialog is open it overlays the right column on
  // wide screens and the whole content area on narrow screens. The
  // audit panel underneath shouldn't scroll out of position when the
  // user wheels over (or near) the dialog — only the dialog's own
  // body should scroll. Lock body scroll for the duration the dialog
  // is open and restore on close.
  useEffect(() => {
    if (!nodeDialog && !edgeDialog) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [nodeDialog, edgeDialog]);

  useEffect(() => {
    setGraphState((prev) => {
      const preferredCenter =
        prev.centerId === null ||
        graphData.nodes.length === 0 ||
        prev.nodes.some((node) => node.id === prev.centerId)
          ? prev.centerId
          : graphData.centerId;
      return graphWithCenter(graphData, preferredCenter);
    });
  }, [graphData]);

  // Re-center the active perspective on the focused node. Mirrors the
  // edge effect below: the recenter follows the *focus* (`focusedNodeId`,
  // which the loader reports even under `?dialog=skip`), while the detail
  // overlay opens only when its detail is present. Señor Doco's
  // auto-focus navigates with `?dialog=skip` — `selectedNode` is null
  // then — but the canvas must still follow the node it just touched
  // instead of staying parked on the previous one. Gating the recenter on
  // `selectedNode` (the old bug) skipped it for every agent auto-focus.
  useEffect(() => {
    if (!focusedNodeId) return;
    if (clientDialogOverrideRef.current) return;
    setEdgeDialog(null);
    setEdgeFocus(null);
    setNodeDialog(selectedNode ? { detail: selectedNode, loading: false, error: null } : null);
    setGraphState((prev) => graphWithCenter(prev, focusedNodeId));
  }, [focusedNodeId, selectedNode]);

  useEffect(() => {
    if (!focusedEdge) return;
    if (clientDialogOverrideRef.current) return;
    setNodeDialog(null);
    setLifecycleError(null);
    setEdgeFocus(edgeFocusFromDetail(focusedEdge));
    setEdgeDialog(selectedEdge ? { detail: selectedEdge, loading: false, error: null } : null);
    setGraphState((prev) => graphWithCenter(prev, focusedEdge.from.id));
  }, [focusedEdge, selectedEdge]);

  // Lifecycle filter is page-level so it persists across perspective
  // tab switches. The set of lifecycles present in the data drives
  // which checkboxes appear; defaults hide retired nodes.
  const availableLifecycles = useMemo(() => {
    const set = new Set<string>(LIFECYCLE_ORDER);
    for (const facet of facets.lifecycle) set.add(facet.value);
    if (selectedNode?.lifecycle) set.add(selectedNode.lifecycle);
    if (focusedEdge?.from.lifecycle) set.add(focusedEdge.from.lifecycle);
    if (focusedEdge?.to.lifecycle) set.add(focusedEdge.to.lifecycle);
    return set;
  }, [facets.lifecycle, selectedNode?.lifecycle, focusedEdge]);

  const [visibleLifecycles, setVisibleLifecycles] = useState<Set<string>>(() =>
    selectedNode
      ? new Set([...initialVisibleLifecycles(availableLifecycles), selectedNode.lifecycle])
      : focusedEdge
        ? new Set([
            ...initialVisibleLifecycles(availableLifecycles),
            focusedEdge.from.lifecycle,
            focusedEdge.to.lifecycle,
          ])
        : initialVisibleLifecycles(availableLifecycles),
  );

  // Surface a lifecycle the data NEWLY introduces, but never re-add one the
  // user deliberately unchecked. The live feed re-creates `availableLifecycles`
  // every revalidation (~5s), so re-seeding from the default-visible set would
  // flip the user's hidden stages back on within seconds. Tracking the stages
  // we've already seen in a ref keeps that toggle stable while still revealing
  // genuinely new stages. (newlyVisibleLifecycles is pure + unit-tested.)
  const knownLifecyclesRef = useRef<Set<string>>(new Set(availableLifecycles));
  useEffect(() => {
    const { newlyVisible, nextKnown } = newlyVisibleLifecycles(
      availableLifecycles,
      knownLifecyclesRef.current,
    );
    knownLifecyclesRef.current = nextKnown;
    if (newlyVisible.length > 0) {
      setVisibleLifecycles((prev) => {
        const next = new Set(prev);
        for (const lifecycle of newlyVisible) next.add(lifecycle);
        return next;
      });
    }
  }, [availableLifecycles]);

  const toggleLifecycle = (lifecycle: string) =>
    setVisibleLifecycles((prev) => {
      const next = new Set(prev);
      if (next.has(lifecycle)) next.delete(lifecycle);
      else next.add(lifecycle);
      return next;
    });

  // Pull-requests perspective lifecycle filter — its own state, held in the URL
  // (`?pr_lifecycle=`) rather than the page-level `visibleLifecycles`. The PR
  // list shows GitHub states (Open / Merged / Closed) and is narrowed
  // server-side, so it needs separate, relabeled controls; keeping the
  // selection in the URL also makes it survive the live feed's revalidation
  // without the re-seed that reset the page-level filter.
  const [searchParams, setSearchParams] = useSearchParams();
  const prLifecycleParam = searchParams.get("pr_lifecycle");
  const prVisibleLifecycles = useMemo(
    () => visiblePrLifecycles(prLifecycleParam),
    [prLifecycleParam],
  );
  const togglePrLifecycle = useCallback(
    (stage: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          const value = togglePrLifecycleParam(next.get("pr_lifecycle"), stage);
          if (value === null) next.delete("pr_lifecycle");
          else next.set("pr_lifecycle", value);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Native browser fullscreen on the aside (tabs + search + canvas +
  // lifecycle filter ride along because they're all inside the aside).
  // Native API gives an actual OS-level fullscreen — Esc exits per
  // browser convention. The node dialog also moves inside the aside
  // when fullscreen so it stays visible on top of the graph (the right
  // column is outside the fullscreen tree and not rendered).
  const contentPaneRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const [showSidePanel, setShowSidePanel] = useState(false);
  const { isFullscreen: isPerspectiveFullscreen, toggle: togglePerspectiveFullscreen } =
    useFullscreen(asideRef);

  // Re-decide the side-by-side layout whenever the pane holding the
  // perspective + panel changes width. That pane is an in-flow flex
  // descendant of <main>, the Señor Doco rail's sibling, so it shrinks when
  // the rail expands (Show Thinking widens it to 640px) and grows when the
  // rail collapses — and it tracks browser resizes. One flag governs both
  // the activity column and where the node dialog renders.
  useEffect(() => {
    const pane = contentPaneRef.current;
    if (!pane) return;

    const update = (paneWidth: number) => {
      // paneWidth spans perspective + gap + panel; the perspective and the
      // panel together (gap excluded) must clear the threshold to sit side
      // by side, otherwise the column hides and the dialog floats on top.
      const next = paneWidth - RIGHT_COLUMN_GRID_GAP >= SIDE_PANEL_MIN_COMBINED_WIDTH;
      setShowSidePanel((prev) => (prev === next ? prev : next));
    };
    const measure = () => update(pane.getBoundingClientRect().width);

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      update(entry?.contentRect.width ?? pane.getBoundingClientRect().width);
    });
    observer.observe(pane);
    return () => observer.disconnect();
  }, []);

  // Live feed polling (ADR-089).
  const revalidator = useRevalidator();
  useEffect(() => {
    let tick: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (tick !== null) return;
      tick = setInterval(() => {
        if (document.visibilityState === "visible" && revalidator.state === "idle") {
          revalidator.revalidate();
        }
      }, 5000);
    };
    const stop = () => {
      if (tick !== null) {
        clearInterval(tick);
        tick = null;
      }
    };
    start();
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [revalidator]);

  const loadNodeDialog = useCallback(
    async (
      entityType: string,
      id: string,
      href: string,
      options: { pushUrl?: boolean; keepDetail?: boolean; focusPerspective?: boolean } = {},
    ) => {
      const pushUrl = options.pushUrl ?? true;
      if (pushUrl && typeof window !== "undefined") {
        clientDialogOverrideRef.current = true;
        // Tag the entry so a Back/Forward popstate can re-open this exact
        // overlay (it's client-only — React Router's location never moves).
        window.history.pushState(nodeDialogHistoryState(id, entityType, href), "", href);
      }
      setEdgeDialog(null);
      setEdgeFocus(null);
      setLifecycleError(null);
      setNodeDialog((prev) => ({
        detail: options.keepDetail ? (prev?.detail ?? null) : null,
        loading: true,
        error: null,
      }));
      try {
        const detailUrl = new URL(`/${handle}/graph-node-details.json`, window.location.origin);
        detailUrl.searchParams.set("type", entityType);
        detailUrl.searchParams.set("id", id);
        const res = await fetch(detailUrl.toString(), {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Request failed with ${res.status}`);
        }
        const json = (await res.json()) as { node?: NodeDialogDetail | null };
        const node = json.node;
        if (!node) throw new Error(`Node not found: ${id}`);
        setNodeDialog({ detail: node, loading: false, error: null });
        setGraphState((prev) => graphWithCenter(prev, node.id));
        // Panel opens (dialog edge rows) re-center the camera on the node,
        // like opening its URL from scratch; canvas clicks leave it be.
        if (options.focusPerspective) setClientFocusId(node.id);
        setVisibleLifecycles((prev) => new Set([...prev, node.lifecycle ?? "active"]));
      } catch (err) {
        setNodeDialog((prev) => ({
          detail: options.keepDetail ? (prev?.detail ?? null) : null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [handle],
  );

  const loadEdgeDialog = useCallback(
    async (
      edge: Pick<OverviewGraphLink, "id" | "href" | "source" | "target">,
      options: { pushUrl?: boolean; keepDetail?: boolean } = {},
    ) => {
      if (!edge.id) return;
      const href = edge.href ?? `/${handle}/edges/${edge.id}`;
      const pushUrl = options.pushUrl ?? true;
      if (pushUrl && typeof window !== "undefined") {
        clientDialogOverrideRef.current = true;
        window.history.pushState(
          edgeDialogHistoryState(edge.id, edge.source ?? null, edge.target ?? null, href),
          "",
          href,
        );
      }
      if (edge.source && edge.target) {
        setEdgeFocus({ id: edge.id, source: edge.source, target: edge.target });
        setGraphState((prev) => graphWithCenter(prev, edge.source));
      }
      setNodeDialog(null);
      setLifecycleError(null);
      setEdgeDialog((prev) => ({
        detail: options.keepDetail ? (prev?.detail ?? null) : null,
        loading: true,
        error: null,
      }));
      try {
        const detailUrl = new URL(`/${handle}/graph-edge-details.json`, window.location.origin);
        detailUrl.searchParams.set("id", edge.id);
        const res = await fetch(detailUrl.toString(), {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Request failed with ${res.status}`);
        }
        const json = (await res.json()) as { edge?: EdgeDialogDetail | null };
        const detail = json.edge;
        if (!detail) throw new Error(`Edge not found: ${edge.id}`);
        setEdgeDialog({ detail, loading: false, error: null });
        setEdgeFocus(edgeFocusFromDetail(detail));
        setGraphState((prev) => graphWithCenter(prev, detail.from.id));
        setVisibleLifecycles(
          (prev) => new Set([...prev, detail.from.lifecycle, detail.to.lifecycle]),
        );
      } catch (err) {
        setEdgeDialog((prev) => ({
          detail: options.keepDetail ? (prev?.detail ?? null) : null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [handle],
  );

  const handleGraphNodeClick = useCallback(
    (node: OverviewGraphNode) => {
      const href = node.href ?? `/${handle}/${node.entity_type}/${node.id}`;
      void loadNodeDialog(node.entity_type, node.id, href);
    },
    [handle, loadNodeDialog],
  );

  const handleGraphEdgeClick = useCallback(
    (edge: OverviewGraphLink) => {
      void loadEdgeDialog(edge);
    },
    [loadEdgeDialog],
  );

  const closeNodeDialog = useCallback(() => {
    clientDialogOverrideRef.current = true;
    setNodeDialog(null);
    setLifecycleError(null);
    if (typeof window !== "undefined") {
      const href =
        activeSlug === "graph"
          ? `/${handle}`
          : `/${handle}?perspective=${encodeURIComponent(activeSlug)}`;
      // Drop any node/edge dialog marker: this entry is now the bare
      // perspective, so a later Back/Forward into it must not re-open an
      // overlay the user already dismissed.
      window.history.replaceState(null, "", href);
    }
  }, [activeSlug, handle]);

  const closeEdgeDialog = useCallback(() => {
    clientDialogOverrideRef.current = true;
    setEdgeDialog(null);
    setEdgeFocus(null);
    setGraphState((prev) => graphWithCenter(prev, null));
    if (typeof window !== "undefined") {
      const href =
        activeSlug === "graph"
          ? `/${handle}`
          : `/${handle}?perspective=${encodeURIComponent(activeSlug)}`;
      // Drop any node/edge dialog marker: this entry is now the bare
      // perspective, so a later Back/Forward into it must not re-open an
      // overlay the user already dismissed.
      window.history.replaceState(null, "", href);
    }
  }, [activeSlug, handle]);

  const clearPerspectiveFocus = useCallback(() => {
    clientDialogOverrideRef.current = true;
    setNodeDialog(null);
    setEdgeDialog(null);
    setEdgeFocus(null);
    setLifecycleError(null);
    setGraphState((prev) => graphWithCenter(prev, null));
    if (typeof window !== "undefined") {
      const href =
        activeSlug === "graph"
          ? `/${handle}`
          : `/${handle}?perspective=${encodeURIComponent(activeSlug)}`;
      // Drop any node/edge dialog marker: this entry is now the bare
      // perspective, so a later Back/Forward into it must not re-open an
      // overlay the user already dismissed.
      window.history.replaceState(null, "", href);
    }
  }, [activeSlug, handle]);

  // Back/Forward reconciliation. Opening a node/edge overlay pushes a
  // client-only history entry (loadNodeDialog / loadEdgeDialog) without a
  // React Router navigation, so RR's location never moves and Back would
  // otherwise change the URL while leaving the overlay on screen. Read the
  // marker we stored on each entry and re-open (Back/Forward into an
  // overlay) or dismiss (Back to the bare perspective) to match the URL.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPopState = (event: PopStateEvent) => {
      const action: DialogHistoryAction = readDialogHistoryState(event.state);
      clientDialogOverrideRef.current = true;
      if (action.kind === "node") {
        const entityType = action.entityType || entityTypeFromPathname(window.location.pathname);
        const href = action.href ?? `${window.location.pathname}${window.location.search}`;
        if (!entityType) {
          setNodeDialog(null);
          return;
        }
        void loadNodeDialog(entityType, action.id, href, {
          pushUrl: false,
          focusPerspective: true,
        });
        return;
      }
      if (action.kind === "edge") {
        const href = action.href ?? `${window.location.pathname}${window.location.search}`;
        // loadEdgeDialog only re-centers when both endpoints are present
        // (`edge.source && edge.target`), so empty-string fallbacks here
        // simply skip the re-center for an older marker that lacks them.
        void loadEdgeDialog(
          { id: action.id, href, source: action.source ?? "", target: action.target ?? "" },
          { pushUrl: false },
        );
        return;
      }
      // No dialog marker on this entry — the user navigated back to the
      // bare perspective. Dismiss whatever overlay is open.
      setNodeDialog(null);
      setEdgeDialog(null);
      setEdgeFocus(null);
      setLifecycleError(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadNodeDialog, loadEdgeDialog]);

  const handleLifecycleChange = useCallback(
    async (stage: LifecycleStage) => {
      const detail = nodeDialog?.detail;
      if (!detail) return;
      const option = detail.lifecycle_options.find((candidate) => candidate.value === stage);
      if (!option || option.disabled || !detail.update_url) return;
      setLifecycleUpdating(stage);
      setLifecycleError(null);
      try {
        const res = await fetch(detail.update_url, {
          method: "PATCH",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ lifecycle: stage }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `Lifecycle update failed with ${res.status}`);
        }
        setGraphState((prev) => graphWithNodeLifecycle(prev, detail.id, stage));
        setNodeDialog((prev) =>
          prev?.detail?.id === detail.id
            ? {
                ...prev,
                detail: {
                  ...prev.detail,
                  lifecycle: stage,
                },
              }
            : prev,
        );
        await loadNodeDialog(detail.entity_type, detail.id, detail.href, {
          pushUrl: false,
          keepDetail: true,
        });
      } catch (err) {
        setLifecycleError(err instanceof Error ? err.message : String(err));
      } finally {
        setLifecycleUpdating(null);
      }
    },
    [loadNodeDialog, nodeDialog],
  );

  const focusedGraphNodeIds = useMemo(
    () => (edgeFocus ? [edgeFocus.source, edgeFocus.target] : []),
    [edgeFocus],
  );

  const allSearchHref = allNodesSearchPath(handle);

  const sections: NodesOverviewSection[] = [
    {
      title: "Node types",
      items: facets.entityType.map((t) => ({
        key: `type-${t.value}`,
        href: nodeTypeSearchPath(handle, t.value),
        label: nodeTypeLabel(t.value),
        icon: <NodeTypeIcon entityType={t.value} />,
        count: t.count,
        counts: t.counts,
        ariaLabel: `Search ${t.count} ${nodeTypeLabel(t.value).toLowerCase()}`,
        updatedAt: t.updatedAt,
      })),
    },
    {
      title: "Edge types",
      items: facets.edgeType.map((e) => ({
        key: `edge-${e.value}`,
        href: edgeTypeListPath(handle, e.value),
        label: edgeTypeLabel(e.value),
        icon: <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.7} />,
        count: e.count,
        ariaLabel: `View ${e.count} ${edgeTypeLabel(e.value).toLowerCase()} edge${
          e.count === 1 ? "" : "s"
        }`,
        updatedAt: e.updatedAt,
      })),
    },
  ];

  // Shared detail-dialog content. The same `showSidePanel` flag that shows
  // the activity column also picks the dialog's wrapper: an absolute overlay
  // inside the right column when the pane is wide enough for both, otherwise
  // a fixed overlay floating on top of the perspective. Both wrappers reuse
  // this element so the props aren't duplicated.
  const activeDialogPanel =
    nodeDialog && !isPerspectiveFullscreen ? (
      <NodeDialog
        detail={nodeDialog.detail}
        loading={nodeDialog.loading}
        error={nodeDialog.error}
        lifecycleUpdating={lifecycleUpdating}
        lifecycleError={lifecycleError}
        onClose={closeNodeDialog}
        onLifecycleChange={handleLifecycleChange}
        onOpenNode={(entityType, id, href) => {
          void loadNodeDialog(entityType, id, href, { focusPerspective: true });
        }}
      />
    ) : edgeDialog && !isPerspectiveFullscreen ? (
      <EdgeDialog
        detail={edgeDialog.detail}
        loading={edgeDialog.loading}
        error={edgeDialog.error}
        onClose={closeEdgeDialog}
        onOpenNode={(entityType, id, href) => {
          void loadNodeDialog(entityType, id, href, { focusPerspective: true });
        }}
      />
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SiteHeader me={me} />
      <main className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-6">
        {/* Title row — spans both columns so the action buttons sit beside the
            title rather than visually attached to the fishbone graph below. */}
        <PageHeader
          className="mb-6 shrink-0"
          breadcrumb={[
            { label: "Home", to: "/" },
            ...(ownerSlug
              ? [
                  {
                    label: ownerSlug,
                    to: ownerIsWorkspace ? `/workspaces/${ownerSlug}` : `/users/${ownerSlug}`,
                  },
                ]
              : []),
            { label: handle },
          ]}
          title={
            <Link to={allSearchHref} className="hover:text-primary">
              {handle}
            </Link>
          }
          actions={
            <>
              <Link
                to={`/${handle}/policies`}
                className="neu-button shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
              >
                Policies ({policyCount})
              </Link>
              {canInviteUsers ? (
                <Link
                  to={`/${handle}/settings`}
                  className="neu-button shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
                >
                  Settings
                </Link>
              ) : null}
            </>
          }
        >
          {goal ? <p className="text-[11px] text-muted-foreground">{goal}</p> : null}
        </PageHeader>
        <div
          ref={contentPaneRef}
          className={`grid min-h-0 flex-1 gap-6 ${
            showSidePanel ? "grid-cols-[minmax(0,1fr)_320px]" : "grid-cols-1"
          }`}
        >
          <aside ref={asideRef} className="flex min-h-0 min-w-0 flex-col bg-background">
            <PerspectiveTabs
              handle={handle}
              perspectives={perspectives}
              availablePerspectives={availablePerspectives}
              activeSlug={activeSlug}
              canAdmin={canAdminPerspectives}
            />
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Floats over the top-right of whichever perspective is
                  active — see PerspectiveSearchOverlay for the z-index it
                  must hold to stay above the canvas. */}
              <PerspectiveSearchOverlay handle={handle} totalNodes={totalNodes} />
              <PerspectiveFrame
                fillHeight
                lifecycleFilter={
                  // The Pull requests list runs its own filter — GitHub states
                  // (Open / Merged / Closed), narrowed server-side, kept in the
                  // URL. Every other perspective uses the page-level set.
                  effectivePerspectiveKind === "pull-requests"
                    ? {
                        visible: prVisibleLifecycles,
                        available: PR_LIFECYCLE_ORDER,
                        onToggle: togglePrLifecycle,
                        labelFor: pullRequestLabel,
                      }
                    : {
                        visible: visibleLifecycles,
                        available: availableLifecycles,
                        onToggle: toggleLifecycle,
                      }
                }
                fullscreen={{
                  isFullscreen: isPerspectiveFullscreen,
                  onToggle: togglePerspectiveFullscreen,
                }}
              >
                {effectivePerspectiveKind === "list" ? (
                  <ListPerspective
                    nodes={graphState.nodes}
                    pageRanks={pageRanksMap}
                    visibleLifecycles={visibleLifecycles}
                    focusId={perspectiveFocusId}
                    loadedCount={graphState.nodes.length}
                    totalCount={graphState.totalNodeCount ?? graphState.nodes.length}
                  />
                ) : effectivePerspectiveKind === "glossary" && glossaryData ? (
                  <GlossaryPerspective
                    data={glossaryData}
                    title={handle}
                    visibleLifecycles={visibleLifecycles}
                    focusId={perspectiveFocusId}
                    onOpenNode={(entry) => {
                      void loadNodeDialog(
                        entry.entityType,
                        entry.id,
                        withPerspectiveParam(entry.href, activeSlug),
                      );
                    }}
                  />
                ) : effectivePerspectiveKind === "pull-requests" && pullRequestsData ? (
                  <PullRequestsPerspective
                    data={pullRequestsData}
                    handle={handle}
                    focusId={perspectiveFocusId}
                    filtered={prVisibleLifecycles.size < PR_LIFECYCLE_ORDER.length}
                  />
                ) : effectivePerspectiveKind === "sla" && slaData ? (
                  <SlaPerspective data={slaData} visibleLifecycles={visibleLifecycles} />
                ) : effectivePerspectiveKind === "org-tree" && orgTreeData ? (
                  <OrgTreePerspective
                    nodes={orgTreeData.nodes}
                    totalCount={orgTreeData.totalCount}
                    visibleLifecycles={visibleLifecycles}
                    centerId={graphState.centerId}
                    initialFocusId={perspectiveFocusId}
                    onCenterChange={(id) => {
                      setEdgeDialog(null);
                      setEdgeFocus(null);
                      setGraphState((prev) => graphWithCenter(prev, id));
                    }}
                    onPaneClick={clearPerspectiveFocus}
                    onNodeClick={(node) => {
                      void loadNodeDialog("principal", node.id, node.href);
                    }}
                  />
                ) : effectivePerspectiveKind === "bpmn" && bpmnGraph ? (
                  <BpmnPerspective
                    docoHandle={handle}
                    pools={bpmnGraph.pools}
                    lanes={bpmnGraph.lanes}
                    nodes={bpmnGraph.nodes}
                    totalCount={bpmnGraph.totalCount}
                    links={bpmnGraph.links}
                    visibleLifecycles={visibleLifecycles}
                    centerId={graphState.centerId}
                    initialFocusId={perspectiveFocusId}
                    focusedEdgeId={edgeFocus?.id ?? null}
                    focusedNodeIds={focusedGraphNodeIds}
                    onCenterChange={(id) => setGraphState((prev) => graphWithCenter(prev, id))}
                    onPaneClick={clearPerspectiveFocus}
                    onEdgeClick={handleGraphEdgeClick}
                    onNodeClick={(node) => {
                      void loadNodeDialog(
                        node.entity_type,
                        node.id,
                        node.href ?? `/${handle}/${node.entity_type}/${node.id}`,
                      );
                    }}
                    onPoolClick={(pool) => {
                      if (!pool.intent_id) return;
                      void loadNodeDialog(
                        "intent",
                        pool.intent_id,
                        `/${handle}/intent/${pool.intent_id}`,
                      );
                    }}
                    onLaneClick={(lane) => {
                      if (lane.kind !== "actor" || !lane.base_id.startsWith("principal_")) return;
                      void loadNodeDialog(
                        "principal",
                        lane.base_id,
                        `/${handle}/principal/${lane.base_id}`,
                      );
                    }}
                  />
                ) : (
                  <OverviewGraph
                    docoHandle={handle}
                    centerId={graphState.centerId}
                    nodes={graphState.nodes}
                    links={graphState.links}
                    detailUrl={graphState.detailUrl}
                    pageRanks={pageRanksMap}
                    fillHeight
                    visibleLifecycles={visibleLifecycles}
                    initialFocusId={perspectiveFocusId}
                    focusedEdgeId={edgeFocus?.id ?? null}
                    focusedNodeIds={focusedGraphNodeIds}
                    onCenterChange={(id) => setGraphState((prev) => graphWithCenter(prev, id))}
                    onPaneClick={clearPerspectiveFocus}
                    onNodeClick={handleGraphNodeClick}
                    onEdgeClick={handleGraphEdgeClick}
                  />
                )}
              </PerspectiveFrame>
              {/* Fullscreen-only: render the detail dialog inside the aside,
                  anchored to the right of the canvas. Outside fullscreen, the
                  same dialog renders in the right column (further down). */}
              {isPerspectiveFullscreen && (nodeDialog || edgeDialog) ? (
                <div className="absolute bottom-3 right-3 top-3 z-[100] w-[min(440px,40%)]">
                  {nodeDialog ? (
                    <NodeDialog
                      detail={nodeDialog.detail}
                      loading={nodeDialog.loading}
                      error={nodeDialog.error}
                      lifecycleUpdating={lifecycleUpdating}
                      lifecycleError={lifecycleError}
                      onClose={closeNodeDialog}
                      onLifecycleChange={handleLifecycleChange}
                      onOpenNode={(entityType, id, href) => {
                        void loadNodeDialog(entityType, id, href, { focusPerspective: true });
                      }}
                    />
                  ) : edgeDialog ? (
                    <EdgeDialog
                      detail={edgeDialog.detail}
                      loading={edgeDialog.loading}
                      error={edgeDialog.error}
                      onClose={closeEdgeDialog}
                      onOpenNode={(entityType, id, href) => {
                        void loadNodeDialog(entityType, id, href, { focusPerspective: true });
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          </aside>

          {/* Right column: only appears when the Doco content pane has
              enough inline room. A viewport breakpoint is not enough
              because the Señor Doco rail can consume a large slice of
              the browser width before this page gets laid out. */}
          <div className={`relative min-h-0 min-w-0 ${showSidePanel ? "block" : "hidden"}`}>
            <section className="h-full min-w-0 space-y-5 overflow-y-auto pb-10 pr-1">
              {githubIntegration ? (
                <GithubIntegrationCard handle={handle} importing={githubIntegration.importing} />
              ) : null}

              <Card>
                <CardHeader className="px-4 py-3">
                  <CardTitle className="text-sm">Activity</CardTitle>
                </CardHeader>
                <CardContent>
                  <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
                </CardContent>
              </Card>

              <NodesOverviewCard
                sections={sections}
                empty={
                  <p className="text-xs italic text-muted-foreground">
                    This Doco has no nodes or edges yet.
                  </p>
                }
                aside={<TopContributorsList contributors={topContributors} />}
              />

              <Card>
                <CardHeader className="px-4 py-3">
                  <CardTitle className="text-sm">Latest activity</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {items.length === 0 ? (
                    <div className="px-4 pb-4 text-xs leading-5 text-muted-foreground">
                      No recorded activity yet. Capture a node from the API or CLI; this feed
                      records UI, CLI, and API writes.
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {items.map((it) => (
                        <ActivityFeedLine
                          key={it.event_id}
                          item={it}
                          docoHandle={handle}
                          onOpenNode={(item, href) => {
                            void loadNodeDialog(
                              item.entity_type,
                              item.id,
                              withPerspectiveParam(href, activeSlug),
                            );
                          }}
                        />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
            {/* Wide content pane: dialog overlays the right column
                while the user reads it. Narrow content pane: the fixed
                wrapper below renders the same dialog over the canvas. */}
            {(nodeDialog || edgeDialog) && !isPerspectiveFullscreen ? (
              <div className="absolute inset-0 z-[100]">{activeDialogPanel}</div>
            ) : null}
          </div>
        </div>
        {/* Narrow content pane: floating dialog over the canvas. The
            Señor Doco rail's width is published as a CSS var by
            AgentSidebar so the dialog never covers it. */}
        {(nodeDialog || edgeDialog) && !isPerspectiveFullscreen ? (
          <div
            className={`fixed bottom-4 right-3 top-20 z-[100] [left:calc(var(--senor-doco-rail-width,320px)+0.75rem)] ${
              showSidePanel ? "hidden" : "block"
            }`}
          >
            {activeDialogPanel}
          </div>
        ) : null}
      </main>
    </div>
  );
}

function stringField(
  obj: Record<string, unknown> | null | undefined,
  field: string,
): string | null {
  const value = obj?.[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function firstLine(value: string | null): string | null {
  if (!value) return null;
  const line = value.split("\n", 1)[0];
  return line ?? value;
}

function TopContributorsList({ contributors }: { contributors: TopContributor[] }) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs font-semibold text-foreground">Top contributors</h2>
      {contributors.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">No recorded contributions yet.</p>
      ) : (
        contributors.map((c) => (
          <div key={c.userId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
            <span className="truncate text-xs" title={c.username}>
              {c.username}
            </span>
            <time
              dateTime={c.lastAt}
              title={c.lastAt}
              suppressHydrationWarning
              className="min-w-14 whitespace-nowrap text-right text-[10px] tabular-nums text-muted-foreground"
            >
              {timeAgo(c.lastAt)}
            </time>
          </div>
        ))
      )}
    </section>
  );
}
