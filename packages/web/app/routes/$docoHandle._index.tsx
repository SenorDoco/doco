import { withClient } from "@doco/db";
// Per-Doco home — bare title up top, then the search input, neuron overview,
// activity heatmap, and latest activity feed in a single content column.
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
import { Link, useRevalidator } from "react-router";
import { parse as parseYaml } from "yaml";
import { ActivityFeedLine, type ActivityFeedLineItem } from "~/components/activity-feed-line";
import { ActivityHeatmap } from "~/components/activity-heatmap";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { CollaboratorsLink } from "~/components/invite-collaborators-link";
import {
  LIFECYCLE_ORDER,
  LifecycleFilter,
  initialVisibleLifecycles,
} from "~/components/lifecycle-filter";
import { NeuronDialog } from "~/components/neuron-dialog";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import {
  NeuronsOverviewCard,
  type NeuronsOverviewSection,
} from "~/components/neurons-overview-card";
import {
  OverviewGraph,
  type OverviewGraphData,
  type OverviewGraphNode,
} from "~/components/overview-graph";
import { PerspectiveTabs } from "~/components/perspective-tabs";
import { BpmnPerspective } from "~/components/perspectives/bpmn-perspective";
import { ListPerspective } from "~/components/perspectives/list-perspective";
import { SearchBoxWithHistory } from "~/components/search-box-with-history";
import { SiteHeader } from "~/components/site-header";
import { loadBpmnGraph } from "~/lib/bpmn-perspective.server";
import { docoPath } from "~/lib/db.server";
import { canAdminDoco, canApproveDoco, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadOverviewGraph } from "~/lib/full-graph.server";
import { loadHostConfig } from "~/lib/host.server";
import { lifecycleColor } from "~/lib/neuron-colors";
import {
  type LifecycleStage,
  type NeuronDialogDetail,
  isGraphNeuronType,
  loadNeuronDialogDetail,
} from "~/lib/neuron-detail.server";
import { computePageRank } from "~/lib/page-rank";
import {
  ensureDefaultsAttached,
  listPerspectivesForDoco,
  resolveActivePerspective,
} from "~/lib/perspectives.server";
import { computeFilterFacets } from "~/lib/search-filters.server";
import { timeAgo } from "~/lib/time-ago";

const FEED_LIMIT = 20;
const HEATMAP_WEEKS = 52;
const TOP_CONTRIBUTORS_LIMIT = 10;

interface FeedItem extends ActivityFeedLineItem {
  event_id: string;
}

interface TopContributor {
  principalId: string;
  username: string;
  lastAt: string;
  eventCount: number;
}

const NEURON_TYPE_LABELS: Record<string, string> = {
  decision: "Decisions",
  action: "Actions",
  intent: "Intents",
  rule: "Rules",
  guidance_primitive: "Guidance primitives",
  neuron_authoring_primitive: "Neuron-authoring primitives",
  eval: "Evals",
  reference: "References",
  idea: "Ideas",
};

function neuronTypeLabel(type: string): string {
  return (
    NEURON_TYPE_LABELS[type] ??
    `${type
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")}s`
  );
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle?: string; docoId?: string; type?: string; id?: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  const me = ctx.me;
  const dir = docoPath(handle);
  const requestedNeuron =
    typeof params.type === "string" && typeof params.id === "string"
      ? { entityType: params.type, id: params.id }
      : null;
  if (requestedNeuron && !isGraphNeuronType(requestedNeuron.entityType)) {
    throw new Response("Unknown neuron type", { status: 404 });
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
    // activity only — primitives are constitution metadata with their
    // own surface, and counting their bulk-imported writes here makes
    // a fresh Doco look like work has been captured when none has.
    const rawItems = (
      await c.query<AuditFeedRow>(
        `SELECT event_id, at, entity_type, entity_id, op, before_json, after_json
           FROM audit_events
          WHERE doco_id = $1
            AND entity_type NOT IN ('guidance_primitive', 'neuron_authoring_primitive')
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
        `SELECT id, summary AS label, lifecycle FROM decisions WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM intents WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM ideas WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM rules WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM guidance_primitives WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM neuron_authoring_primitives WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM actions WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM logs WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM evals WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM states WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM reference_entities WHERE doco_id = $1 AND id = ANY($2::text[])`,
        [ctx.meta.docoId, entityIds],
      );
      for (const row of entityLabelRows.rows) {
        entityById.set(row.id, { label: row.label, lifecycle: row.lifecycle });
      }
    }

    const items: FeedItem[] = rawItems.map((it) => {
      const entity = entityById.get(it.entity_id);
      return {
        event_id: it.event_id,
        id: it.entity_id,
        entity_type: it.entity_type,
        summary:
          entity?.label ??
          stringField(it.after_json, "summary") ??
          stringField(it.before_json, "summary"),
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
        `SELECT day, COUNT(*)::text AS n FROM (
           SELECT to_char(created_at, 'YYYY-MM-DD') AS day FROM decisions WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM intents WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM ideas WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM rules WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM actions WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM logs WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM evals WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM reference_entities WHERE doco_id = $1
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM states WHERE doco_id = $1
         ) t WHERE day >= $2
         GROUP BY day`,
        [ctx.meta.docoId, sinceIso.slice(0, 10)],
      )
    ).rows;
    const byDay: Record<string, number> = {};
    for (const r of activityRows) byDay[r.day] = Number(r.n);

    const contributorRows = (
      await c.query<{
        collaborator_id: string;
        username: string;
        last_at: Date | string;
        event_count: string;
      }>(
        `SELECT ae.by_collaborator AS collaborator_id,
                p.username,
                MAX(ae.at) AS last_at,
                COUNT(*)::text AS event_count
           FROM audit_events ae
           JOIN principals p ON p.id = ae.by_collaborator
          WHERE ae.doco_id = $1
            AND ae.by_collaborator IS NOT NULL
            AND ae.entity_type NOT IN ('guidance_primitive', 'neuron_authoring_primitive')
          GROUP BY ae.by_collaborator, p.username
          ORDER BY COUNT(*) DESC, MAX(ae.at) DESC
          LIMIT $2`,
        [ctx.meta.docoId, TOP_CONTRIBUTORS_LIMIT],
      )
    ).rows;
    const topContributors: TopContributor[] = contributorRows.map((r) => ({
      principalId: r.collaborator_id,
      username: r.username,
      lastAt:
        r.last_at instanceof Date
          ? r.last_at.toISOString()
          : new Date(String(r.last_at)).toISOString(),
      eventCount: Number(r.event_count),
    }));
    const selectedNeuron = requestedNeuron
      ? await loadNeuronDialogDetail(c, ctx.meta, {
          handle,
          entityType: requestedNeuron.entityType,
          id: requestedNeuron.id,
          principalId: me?.id ?? null,
        })
      : null;
    if (requestedNeuron && !selectedNeuron) {
      throw new Response(`Neuron not found: ${requestedNeuron.id}`, { status: 404 });
    }
    const graph = await loadOverviewGraph(c, ctx.meta.docoId, {
      handle,
      ...(selectedNeuron ? { centerId: selectedNeuron.id } : {}),
    });

    // Visualization perspectives — tabs above the graph body. Existing
    // Docos created before migration 007 may have no perspectives
    // attached; ensureDefaultsAttached backfills graph + list on first
    // load so the UI always has at least one tab.
    await ensureDefaultsAttached(ctx.meta.docoId);
    const perspectives = await listPerspectivesForDoco(ctx.meta.docoId);
    const requestedSlug = new URL(request.url).searchParams.get("perspective");
    const activePerspective = resolveActivePerspective(perspectives, requestedSlug);
    const canAdminPerspectives = await canApproveDoco(ctx.meta, me?.id ?? null);

    // PageRank over the loaded graph, for the List perspective's rank
    // sort options. Cheap (~ms even for thousands of neurons) so we
    // compute it on every load rather than caching.
    const pageRankMap = computePageRank(graph.nodes, graph.links);
    const pageRanks: Record<string, number> = {};
    for (const [id, rank] of pageRankMap.entries()) pageRanks[id] = rank;

    // BPMN data is only needed when the active perspective is bpmn —
    // skip the principal+data join otherwise.
    const bpmnGraph =
      activePerspective?.kind === "bpmn"
        ? await loadBpmnGraph(c, ctx.meta.docoId, { handle })
        : null;

    // Primitive count — guidance + neuron-authoring primitives
    // attached to this Doco.
    const constitutionRow = (
      await c.query<{ n: string }>(
        `SELECT
           ((SELECT COUNT(*) FROM guidance_primitives WHERE doco_id = $1)
          + (SELECT COUNT(*) FROM neuron_authoring_primitives WHERE doco_id = $1))::text AS n`,
        [ctx.meta.docoId],
      )
    ).rows[0];
    const constitutionCount = Number(constitutionRow?.n ?? 0);

    return {
      items,
      facets,
      totalNodes,
      byDay,
      topContributors,
      ownerSlug,
      docoSlug,
      handle,
      docoId: ctx.meta.docoId,
      canInviteCollaborators: await canAdminDoco(ctx.meta, me?.id ?? null),
      host: await loadHostConfig(),
      me,
      graph,
      constitutionCount,
      perspectives,
      activePerspectiveSlug: activePerspective?.slug ?? null,
      activePerspectiveKind: activePerspective?.kind ?? null,
      canAdminPerspectives,
      pageRanks,
      bpmnGraph,
      selectedNeuron,
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

function lifecycleSearchPath(handle: string, lifecycle: string): string {
  const params = new URLSearchParams();
  params.set("lifecycle", lifecycle);
  params.set("entity_type", "*");
  params.set("limit", "500");
  return `/${handle}/search?${params.toString()}`;
}

interface NeuronDialogState {
  detail: NeuronDialogDetail | null;
  loading: boolean;
  error: string | null;
}

function graphWithCenter(graph: OverviewGraphData, centerId: string): OverviewGraphData {
  const hasCenter = graph.nodes.some((node) => node.id === centerId);
  if (!hasCenter) return graph;
  return {
    ...graph,
    centerId,
    nodes: graph.nodes.map((node) => ({
      ...node,
      is_center: node.id === centerId,
    })),
  };
}

function graphWithNeuronLifecycle(
  graph: OverviewGraphData,
  neuronId: string,
  lifecycle: string,
): OverviewGraphData {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.id === neuronId
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
  if (data?.selectedNeuron) {
    const display =
      data.selectedNeuron.name ?? data.selectedNeuron.summary ?? data.selectedNeuron.id;
    return [{ title: `${display} · ${data.handle} · Doco` }];
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
    ownerSlug,
    docoSlug,
    handle,
    docoId,
    canInviteCollaborators,
    me,
    graph,
    constitutionCount,
    perspectives,
    activePerspectiveSlug,
    activePerspectiveKind,
    canAdminPerspectives,
    pageRanks,
    bpmnGraph,
    selectedNeuron,
  } = loaderData;

  const pageRanksMap = new Map(Object.entries(pageRanks));
  const activeSlug = activePerspectiveSlug ?? "graph";
  const [graphState, setGraphState] = useState<OverviewGraphData>(() => graph);
  const [neuronDialog, setNeuronDialog] = useState<NeuronDialogState | null>(() =>
    selectedNeuron ? { detail: selectedNeuron, loading: false, error: null } : null,
  );
  const [lifecycleUpdating, setLifecycleUpdating] = useState<LifecycleStage | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const clientDialogOverrideRef = useRef(false);

  useEffect(() => {
    setGraphState((prev) => {
      const preferredCenter = prev.nodes.some((node) => node.id === prev.centerId)
        ? prev.centerId
        : graph.centerId;
      return graphWithCenter(graph, preferredCenter);
    });
  }, [graph]);

  useEffect(() => {
    if (!selectedNeuron) return;
    if (clientDialogOverrideRef.current) return;
    setNeuronDialog({ detail: selectedNeuron, loading: false, error: null });
    setGraphState((prev) => graphWithCenter(prev, selectedNeuron.id));
  }, [selectedNeuron]);

  // Lifecycle filter is page-level so it persists across perspective
  // tab switches. The set of lifecycles present in the data drives
  // which checkboxes appear; defaults hide retired neurons.
  const availableLifecycles = useMemo(() => {
    const set = new Set<string>(LIFECYCLE_ORDER);
    for (const node of graphState.nodes) set.add(node.lifecycle ?? "active");
    return set;
  }, [graphState.nodes]);

  const [visibleLifecycles, setVisibleLifecycles] = useState<Set<string>>(() =>
    selectedNeuron
      ? new Set([...initialVisibleLifecycles(availableLifecycles), selectedNeuron.lifecycle])
      : initialVisibleLifecycles(availableLifecycles),
  );

  // Keep visible set in sync if the data introduces a new lifecycle.
  useEffect(() => {
    setVisibleLifecycles((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const lifecycle of availableLifecycles) {
        // Don't auto-show stages that should be hidden by default.
        if (!next.has(lifecycle) && !prev.has(lifecycle)) {
          // initial-hidden stages stay hidden; new not-hidden stages
          // become visible.
          // initialVisibleLifecycles enforces hide-by-default policy.
        }
      }
      const seed = initialVisibleLifecycles(availableLifecycles);
      for (const lifecycle of seed) {
        if (!next.has(lifecycle) && !prev.has(lifecycle)) {
          next.add(lifecycle);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [availableLifecycles]);

  const toggleLifecycle = (lifecycle: string) =>
    setVisibleLifecycles((prev) => {
      const next = new Set(prev);
      if (next.has(lifecycle)) next.delete(lifecycle);
      else next.add(lifecycle);
      return next;
    });

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

  const loadNeuronDialog = useCallback(
    async (
      entityType: string,
      id: string,
      href: string,
      options: { pushUrl?: boolean; keepDetail?: boolean } = {},
    ) => {
      const pushUrl = options.pushUrl ?? true;
      if (pushUrl && typeof window !== "undefined") {
        clientDialogOverrideRef.current = true;
        window.history.pushState({ docoNeuronDialog: id }, "", href);
      }
      setLifecycleError(null);
      setNeuronDialog((prev) => ({
        detail: options.keepDetail ? (prev?.detail ?? null) : null,
        loading: true,
        error: null,
      }));
      try {
        const detailUrl = new URL(`/${handle}/graph-neuron-details.json`, window.location.origin);
        detailUrl.searchParams.set("type", entityType);
        detailUrl.searchParams.set("id", id);
        const res = await fetch(detailUrl.toString(), {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || `Request failed with ${res.status}`);
        }
        const json = (await res.json()) as { neuron?: NeuronDialogDetail | null };
        if (!json.neuron) throw new Error(`Neuron not found: ${id}`);
        setNeuronDialog({ detail: json.neuron, loading: false, error: null });
        setVisibleLifecycles((prev) => new Set([...prev, json.neuron?.lifecycle ?? "active"]));
      } catch (err) {
        setNeuronDialog((prev) => ({
          detail: options.keepDetail ? (prev?.detail ?? null) : null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        }));
      }
    },
    [handle],
  );

  const handleGraphNeuronClick = useCallback(
    (node: OverviewGraphNode) => {
      const href = node.href ?? `/${handle}/${node.entity_type}/${node.id}`;
      void loadNeuronDialog(node.entity_type, node.id, href);
    },
    [handle, loadNeuronDialog],
  );

  const closeNeuronDialog = useCallback(() => {
    clientDialogOverrideRef.current = true;
    setNeuronDialog(null);
    setLifecycleError(null);
    if (typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", `/${handle}`);
    }
  }, [handle]);

  const handleLifecycleChange = useCallback(
    async (stage: LifecycleStage) => {
      const detail = neuronDialog?.detail;
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
        setGraphState((prev) => graphWithNeuronLifecycle(prev, detail.id, stage));
        setNeuronDialog((prev) =>
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
        await loadNeuronDialog(detail.entity_type, detail.id, detail.href, {
          pushUrl: false,
          keepDetail: true,
        });
      } catch (err) {
        setLifecycleError(err instanceof Error ? err.message : String(err));
      } finally {
        setLifecycleUpdating(null);
      }
    },
    [loadNeuronDialog, neuronDialog],
  );

  const allSearchHref = allNodesSearchPath(handle);

  const sections: NeuronsOverviewSection[] = [
    {
      title: "Neuron types",
      items: facets.entityType.map((t) => ({
        key: `type-${t.value}`,
        href: nodeTypeSearchPath(handle, t.value),
        label: neuronTypeLabel(t.value),
        icon: <NeuronTypeIcon entityType={t.value} />,
        count: t.count,
        activeCount: t.activeCount,
        ariaLabel: `Search ${t.count} ${neuronTypeLabel(t.value).toLowerCase()}`,
        updatedAt: t.updatedAt,
      })),
    },
    {
      title: "Lifecycle",
      items: facets.lifecycle.map((l) => ({
        key: `lifecycle-${l.value}`,
        href: lifecycleSearchPath(handle, l.value),
        label: l.value,
        count: l.count,
        ariaLabel: `Search ${l.count} neurons in lifecycle ${l.value}`,
        color: lifecycleColor(l.value),
        updatedAt: l.updatedAt,
      })),
    },
  ];

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-[1800px] px-6 pb-8 pt-6">
        {/* Title row — spans both columns so the action buttons sit beside the
            title rather than visually attached to the fishbone graph below. */}
        <div className="mb-6 space-y-1">
          <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle })} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-lg font-semibold tracking-tight">
              <Link to={allSearchHref} className="hover:text-primary">
                {handle}
              </Link>
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              {canInviteCollaborators ? <CollaboratorsLink level="doco" targetId={docoId} /> : null}
              <Link
                to={`/${handle}/constitution`}
                className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
              >
                Primitives ({constitutionCount})
              </Link>
              {canInviteCollaborators ? (
                <Link
                  to={`/${handle}/settings`}
                  className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
                >
                  Settings
                </Link>
              ) : null}
            </div>
          </div>
          <p className="font-mono text-sm text-muted-foreground">{docoId}</p>
        </div>
        <div className="grid grid-cols-1 gap-6 min-[1200px]:grid-cols-[minmax(0,1fr)_400px]">
          <aside className="flex h-[calc(100vh-17rem)] min-h-[480px] min-w-0 flex-col min-[1200px]:sticky min-[1200px]:top-4 min-[1200px]:self-start">
            <PerspectiveTabs
              handle={handle}
              perspectives={perspectives}
              activeSlug={activeSlug}
              canAdmin={canAdminPerspectives}
              search={
                <SearchBoxWithHistory
                  handle={handle}
                  placeholder={
                    totalNodes > 0
                      ? `Search ${totalNodes} neuron${totalNodes === 1 ? "" : "s"}…`
                      : "Search neurons…"
                  }
                  compact
                />
              }
            />
            <div className="flex min-h-0 flex-1 flex-col">
              {activePerspectiveKind === "list" ? (
                <ListPerspective
                  nodes={graphState.nodes}
                  pageRanks={pageRanksMap}
                  visibleLifecycles={visibleLifecycles}
                />
              ) : activePerspectiveKind === "bpmn" && bpmnGraph ? (
                <BpmnPerspective
                  lanes={bpmnGraph.lanes}
                  nodes={bpmnGraph.nodes}
                  links={bpmnGraph.links}
                  visibleLifecycles={visibleLifecycles}
                  onNeuronClick={(node) => {
                    void loadNeuronDialog(
                      node.entity_type,
                      node.id,
                      node.href ?? `/${handle}/${node.entity_type}/${node.id}`,
                    );
                  }}
                />
              ) : (
                <OverviewGraph
                  centerId={graphState.centerId}
                  nodes={graphState.nodes}
                  links={graphState.links}
                  detailUrl={graphState.detailUrl}
                  fillHeight
                  visibleLifecycles={visibleLifecycles}
                  onNeuronClick={handleGraphNeuronClick}
                />
              )}
            </div>
          </aside>

          <section className="hidden min-w-0 space-y-5 min-[1200px]:block">
            <NeuronsOverviewCard
              sections={sections}
              empty={
                <p className="text-xs italic text-muted-foreground">
                  This Doco has no neurons yet.
                </p>
              }
              aside={<TopContributorsList contributors={topContributors} />}
            />

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityHeatmap byDay={byDay} weeks={HEATMAP_WEEKS} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="px-4 py-3">
                <CardTitle className="text-sm">Latest activity</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {items.length === 0 ? (
                  <div className="px-4 pb-4 text-xs leading-5 text-muted-foreground">
                    No recorded activity yet. Capture a neuron from the API or CLI; this feed
                    records UI, CLI, and API writes.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {items.map((it) => (
                      <ActivityFeedLine
                        key={it.event_id}
                        item={it}
                        ownerSlug={ownerSlug}
                        docoSlug={docoSlug}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
          {neuronDialog ? (
            <div className="fixed inset-x-3 bottom-4 top-20 z-30 min-[1200px]:sticky min-[1200px]:bottom-auto min-[1200px]:left-auto min-[1200px]:right-auto min-[1200px]:top-4 min-[1200px]:col-start-2 min-[1200px]:row-start-1 min-[1200px]:h-[calc(100vh-17rem)] min-[1200px]:min-h-[480px] min-[1200px]:self-start">
              <NeuronDialog
                detail={neuronDialog.detail}
                loading={neuronDialog.loading}
                error={neuronDialog.error}
                lifecycleUpdating={lifecycleUpdating}
                lifecycleError={lifecycleError}
                onClose={closeNeuronDialog}
                onLifecycleChange={handleLifecycleChange}
                onOpenNeuron={(entityType, id, href) => {
                  void loadNeuronDialog(entityType, id, href);
                }}
              />
            </div>
          ) : null}
        </div>

        {/* Page-level lifecycle filter — shared across every
            perspective (graph / list / BPMN) so toggles persist when
            switching tabs. Sits below the perspective body, full
            width. */}
        <div className="mt-6">
          <LifecycleFilter
            available={availableLifecycles}
            visible={visibleLifecycles}
            onToggle={toggleLifecycle}
          />
        </div>
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

function TopContributorsList({ contributors }: { contributors: TopContributor[] }) {
  return (
    <section className="space-y-1">
      <h2 className="text-xs font-semibold text-foreground">Top contributors</h2>
      {contributors.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">No recorded contributions yet.</p>
      ) : (
        contributors.map((c) => (
          <div
            key={c.principalId}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
          >
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
