import { getCollaboratorById, withClient } from "@doco/db";
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
import { LIFECYCLE_ORDER, initialVisibleLifecycles } from "~/components/lifecycle-filter";
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
  listAvailablePerspectives,
  listPerspectivesForDoco,
  resolveActivePerspective,
} from "~/lib/perspectives.server";
import { computeFilterFacets } from "~/lib/search-filters.server";
import { timeAgo } from "~/lib/time-ago";
import { useFullscreen } from "~/lib/use-fullscreen";

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
  guidance_policy: "Guidance policies",
  neuron_authoring_policy: "Neuron-authoring policies",
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
    // activity only — policies are Doco-level metadata with their
    // own surface, and counting their bulk-imported writes here makes
    // a fresh Doco look like work has been captured when none has.
    const rawItems = (
      await c.query<AuditFeedRow>(
        `SELECT event_id, at, entity_type, entity_id, op, before_json, after_json
           FROM audit_events
          WHERE doco_id = $1
            AND entity_type NOT IN ('guidance_policy', 'neuron_authoring_policy')
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
        `SELECT id, split_part(decision, E'\n', 1) AS label, lifecycle FROM decisions WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, split_part(intent, E'\n', 1) AS label, lifecycle FROM intents WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, split_part(idea, E'\n', 1) AS label, lifecycle FROM ideas WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, split_part(rule, E'\n', 1) AS label, lifecycle FROM rules WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM guidance_policies WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, summary AS label, lifecycle FROM neuron_authoring_policies WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, split_part(action, E'\n', 1) AS label, lifecycle FROM actions WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, split_part(log, E'\n', 1) AS label, lifecycle FROM logs WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, split_part(eval, E'\n', 1) AS label, lifecycle FROM evals WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, split_part(state, E'\n', 1) AS label, lifecycle FROM states WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, split_part(reference, E'\n', 1) AS label, lifecycle FROM reference_entities WHERE doco_id = $1 AND id = ANY($2::text[])
         UNION ALL SELECT id, COALESCE(summary, name) AS label, lifecycle FROM principals WHERE doco_id = $1 AND id = ANY($2::text[])`,
        [ctx.meta.docoId, entityIds],
      );
      for (const row of entityLabelRows.rows) {
        entityById.set(row.id, { label: row.label, lifecycle: row.lifecycle });
      }
    }

    const items: FeedItem[] = rawItems.map((it) => {
      const entity = entityById.get(it.entity_id);
      // Audit events may carry the prose under the type-named key for
      // migrated neurons (intent/decision/...) or `summary` for legacy
      // captures. Look both up; the first non-empty line wins.
      const proseKey = it.entity_type;
      return {
        event_id: it.event_id,
        id: it.entity_id,
        entity_type: it.entity_type,
        summary:
          entity?.label ??
          firstLine(stringField(it.after_json, proseKey)) ??
          firstLine(stringField(it.before_json, proseKey)) ??
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
           UNION ALL SELECT to_char(created_at, 'YYYY-MM-DD') FROM principals WHERE doco_id = $1
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
        principal_name: string;
        last_at: Date | string;
        event_count: string;
      }>(
        `SELECT ae.by_collaborator AS collaborator_id,
                p.name AS principal_name,
                MAX(ae.at) AS last_at,
                COUNT(*)::text AS event_count
           FROM audit_events ae
           JOIN principals p ON p.id = ae.by_collaborator
          WHERE ae.doco_id = $1
            AND ae.by_collaborator IS NOT NULL
            AND ae.entity_type NOT IN ('guidance_policy', 'neuron_authoring_policy')
          GROUP BY ae.by_collaborator, p.name
          ORDER BY COUNT(*) DESC, MAX(ae.at) DESC
          LIMIT $2`,
        [ctx.meta.docoId, TOP_CONTRIBUTORS_LIMIT],
      )
    ).rows;
    const topContributors: TopContributor[] = contributorRows.map((r) => ({
      principalId: r.collaborator_id,
      username: r.principal_name,
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
    const [perspectives, availablePerspectives] = await Promise.all([
      listPerspectivesForDoco(ctx.meta.docoId),
      listAvailablePerspectives(),
    ]);
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

    // Policy count — guidance + neuron-authoring policies
    // attached to this Doco.
    const policyRow = (
      await c.query<{ n: string }>(
        `SELECT
           ((SELECT COUNT(*) FROM guidance_policies WHERE doco_id = $1)
          + (SELECT COUNT(*) FROM neuron_authoring_policies WHERE doco_id = $1))::text AS n`,
        [ctx.meta.docoId],
      )
    ).rows[0];
    const policyCount = Number(policyRow?.n ?? 0);

    // Per-user UI preferences (currently just the graph "Reorder
    // automatically" toggle). Anonymous viewers get the default-on
    // experience and any toggle change is dropped on the floor.
    const meRow = me ? await getCollaboratorById(me.id) : null;
    const prefs = (meRow?.data?.preferences ?? {}) as Record<string, unknown>;
    const graphAutoReorder = prefs.graph_auto_reorder !== false; // default true

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
      goal: ctx.meta.goal,
      canInviteCollaborators: await canAdminDoco(ctx.meta, me?.id ?? null),
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
      selectedNeuron,
      graphAutoReorder,
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
    goal,
    canInviteCollaborators,
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
    selectedNeuron,
    graphAutoReorder: initialAutoReorder,
  } = loaderData;

  const pageRanksMap = new Map(Object.entries(pageRanks));
  const [autoReorder, setAutoReorder] = useState<boolean>(initialAutoReorder);
  const handleAutoReorderChange = useCallback((next: boolean) => {
    setAutoReorder(next);
    // Best-effort fire-and-forget. If the request fails the user
    // still sees the toggle reflect their click for the rest of the
    // session — the worst case is the next reload reverts.
    void fetch("/api/v1/me/preferences.json", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: { graph_auto_reorder: next } }),
    }).catch(() => undefined);
  }, []);
  const activeSlug = activePerspectiveSlug ?? "graph";
  const [graphState, setGraphState] = useState<OverviewGraphData>(() => graph);
  const [neuronDialog, setNeuronDialog] = useState<NeuronDialogState | null>(() =>
    selectedNeuron ? { detail: selectedNeuron, loading: false, error: null } : null,
  );
  const [lifecycleUpdating, setLifecycleUpdating] = useState<LifecycleStage | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const clientDialogOverrideRef = useRef(false);

  // While the neuron dialog is open it overlays the right column on
  // wide screens and the whole content area on narrow screens. The
  // audit panel underneath shouldn't scroll out of position when the
  // user wheels over (or near) the dialog — only the dialog's own
  // body should scroll. Lock body scroll for the duration the dialog
  // is open and restore on close.
  useEffect(() => {
    if (!neuronDialog) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [neuronDialog]);

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

  // Native browser fullscreen on the aside (tabs + search + canvas +
  // lifecycle filter ride along because they're all inside the aside).
  // Native API gives an actual OS-level fullscreen — Esc exits per
  // browser convention. The neuron dialog also moves inside the aside
  // when fullscreen so it stays visible on top of the graph (the right
  // column is outside the fullscreen tree and not rendered).
  const asideRef = useRef<HTMLElement>(null);
  const { isFullscreen: isPerspectiveFullscreen, toggle: togglePerspectiveFullscreen } =
    useFullscreen(asideRef);

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

  // Shared NeuronDialog content. The dialog renders in one of two
  // positioning wrappers (a fixed overlay below 1200px, an absolute
  // overlay inside the right column at ≥ 1200px); both reuse this same
  // element so the props aren't duplicated.
  const neuronDialogPanel =
    neuronDialog && !isPerspectiveFullscreen ? (
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
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SiteHeader mode="host" me={me} />
      <main className="flex min-h-0 flex-1 flex-col px-6 pb-6 pt-6">
        {/* Title row — spans both columns so the action buttons sit beside the
            title rather than visually attached to the fishbone graph below. */}
        <div className="mb-6 shrink-0 space-y-1">
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
                to={`/${handle}/policies`}
                className="neu-button shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
              >
                Policies ({policyCount})
              </Link>
              {canInviteCollaborators ? (
                <Link
                  to={`/${handle}/settings`}
                  className="neu-button shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
                >
                  Settings
                </Link>
              ) : null}
            </div>
          </div>
          {goal ? <p className="text-[11px] text-muted-foreground">{goal}</p> : null}
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 min-[1200px]:grid-cols-[minmax(0,1fr)_320px]">
          <aside ref={asideRef} className="flex min-h-0 min-w-0 flex-col bg-background">
            <PerspectiveTabs
              handle={handle}
              perspectives={perspectives}
              availablePerspectives={availablePerspectives}
              activeSlug={activeSlug}
              canAdmin={canAdminPerspectives}
            />
            <div className="relative flex min-h-0 flex-1 flex-col">
              {/* Search floats over the top-left of whichever perspective
                  is active. Absolute so it sits inside the canvas without
                  pushing it down — keeps the tab/canvas seam clean. */}
              <div className="pointer-events-none absolute left-3 top-3 z-20 w-64 max-w-[calc(100%-2rem)]">
                <div className="pointer-events-auto">
                  <SearchBoxWithHistory
                    handle={handle}
                    placeholder={
                      totalNodes > 0
                        ? `Search ${totalNodes} neuron${totalNodes === 1 ? "" : "s"}…`
                        : "Search neurons…"
                    }
                    compact
                  />
                </div>
              </div>
              {activePerspectiveKind === "list" ? (
                <ListPerspective
                  nodes={graphState.nodes}
                  pageRanks={pageRanksMap}
                  visibleLifecycles={visibleLifecycles}
                />
              ) : activePerspectiveKind === "bpmn" && bpmnGraph ? (
                <BpmnPerspective
                  pools={bpmnGraph.pools}
                  lanes={bpmnGraph.lanes}
                  nodes={bpmnGraph.nodes}
                  links={bpmnGraph.links}
                  globalPagerank={bpmnGraph.global_pagerank}
                  visibleLifecycles={visibleLifecycles}
                  availableLifecycles={availableLifecycles}
                  onLifecycleToggle={toggleLifecycle}
                  centerId={graphState.centerId}
                  onCenterChange={(id) => setGraphState((prev) => graphWithCenter(prev, id))}
                  isFullscreen={isPerspectiveFullscreen}
                  onToggleFullscreen={togglePerspectiveFullscreen}
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
                  onLifecycleToggle={toggleLifecycle}
                  autoReorder={autoReorder}
                  onAutoReorderChange={handleAutoReorderChange}
                  onCenterChange={(id) => setGraphState((prev) => graphWithCenter(prev, id))}
                  isFullscreen={isPerspectiveFullscreen}
                  onToggleFullscreen={togglePerspectiveFullscreen}
                  onNeuronClick={handleGraphNeuronClick}
                />
              )}
              {/* Fullscreen-only: render the neuron dialog inside the aside,
                  anchored to the right of the canvas. Outside fullscreen, the
                  same dialog renders in the right column (further down). */}
              {isPerspectiveFullscreen && neuronDialog ? (
                <div className="absolute bottom-3 right-3 top-3 z-20 w-[min(440px,40%)]">
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
          </aside>

          {/* Right column: only renders ≥ 1200px. Below that breakpoint
              the cards are out of layout AND we drop the wrapper div
              entirely so it doesn't create a phantom grid row (auto +
              gap-6) that left ~50px of unowned space below the graph. */}
          <div className="relative hidden min-h-0 min-w-0 min-[1200px]:block">
            <section className="h-full min-w-0 space-y-5 overflow-y-auto pr-1">
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
                        <ActivityFeedLine key={it.event_id} item={it} docoHandle={handle} />
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
            {/* ≥1200px: dialog overlays the right column (covers the
                cards while the user reads it). At < 1200px the wrapper
                below this one renders the same dialog over the canvas. */}
            {neuronDialog && !isPerspectiveFullscreen ? (
              <div className="absolute inset-0">{neuronDialogPanel}</div>
            ) : null}
          </div>
        </div>
        {/* < 1200px: floating dialog over the canvas (the right column
            isn't rendered at this breakpoint). The Señor Doco rail's
            width is published as a CSS var by AgentSidebar so the
            dialog never covers it. */}
        {neuronDialog && !isPerspectiveFullscreen ? (
          <div className="fixed bottom-4 right-3 top-20 z-30 [left:calc(var(--senor-doco-rail-width,320px)+0.75rem)] min-[1200px]:hidden">
            {neuronDialogPanel}
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
