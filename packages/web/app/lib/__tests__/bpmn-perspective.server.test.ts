import { describe, expect, it } from "vitest";
import { computeNearestIntentByNode, loadBpmnGraph } from "../bpmn-perspective.server";

interface CapturedQuery {
  sql: string;
  params?: unknown[];
}

interface QueryClientLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

function makeQueryClient(rows: Record<string, unknown[]>) {
  const captured: CapturedQuery[] = [];
  const client: QueryClientLike = {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      captured.push({ sql, params });
      if (/FROM edges/i.test(sql)) {
        return { rows: (rows.edges ?? []) as T[] };
      }
      if (/FROM users/i.test(sql)) return { rows: (rows.users ?? []) as T[] };
      // Principals are loaded via `FROM nodes WHERE node_type = 'principal'`.
      if (/node_type = 'principal'/i.test(sql)) return { rows: (rows.principals ?? []) as T[] };
      return { rows: (rows.nodes ?? []) as T[] };
    },
  };
  return { client, captured };
}

function edge(
  id: string,
  from_id: string,
  to_id: string,
  edge_type: string,
  edge_props_json: Record<string, unknown> | null = null,
) {
  const roleEdgeTypes: Record<string, string> = {
    serves: "supports",
    enacts: "supports",
    tests: "supports",
    implemented_by: "supports",
    gated_by: "constrained_by",
    consults: "constrained_by",
    performed_by: "attributed_to",
    owned_by: "attributed_to",
    decided_by: "attributed_to",
    reports_to: "has_parent",
    dotted_reports_to: "has_parent",
  };
  const canonical = roleEdgeTypes[edge_type];
  if (canonical) {
    return {
      id,
      from_id,
      to_id,
      edge_type: canonical,
      edge_props_json: { ...(edge_props_json ?? {}), role: edge_type },
    };
  }
  return { id, from_id, to_id, edge_type, edge_props_json };
}

describe("loadBpmnGraph", () => {
  it("selects the full prose as the node summary, not just the first line", async () => {
    // Perspectives render the full node name — the loader must not truncate
    // the summary to the first line of prose with split_part().
    const { client, captured } = makeQueryClient({
      nodes: [],
      principals: [],
      users: [],
      edges: [],
    });

    await loadBpmnGraph(client, "doco_01", { handle: "refunds" });

    const nodeQuery = captured.find((q) => /AS summary/i.test(q.sql));
    expect(nodeQuery?.sql).toMatch(/t\.prose AS summary/);
    expect(nodeQuery?.sql).not.toMatch(/split_part\([^)]*prose/);
  });

  it("resolves drafting Principals as BPMN actor lanes", async () => {
    const { client, captured } = makeQueryClient({
      nodes: [
        {
          id: "intent_01PROCESS",
          entity_type: "intent",
          summary: "Refund request handled",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: "action_01CHECK",
          entity_type: "action",
          summary: "Review refund request",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
      ],
      principals: [
        {
          id: "principal_support",
          name: "Support",
          lifecycle: "drafting",
        },
      ],
      users: [],
      edges: [
        edge("edge_01SERVES", "action_01CHECK", "intent_01PROCESS", "serves"),
        edge("edge_01ACTOR", "action_01CHECK", "principal_support", "performed_by"),
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "refunds" });

    const principalQuery = captured.find((q) => /node_type = 'principal'/i.test(q.sql));
    // Drafting Principals must load (the lifecycle filter is the client's
    // job), so the principal query must not narrow to active-only.
    expect(principalQuery?.sql).not.toMatch(/COALESCE\(lifecycle, 'active'\) = 'active'/);

    expect(graph.lanes).toContainEqual(
      expect.objectContaining({
        id: "pool:intent_01PROCESS::principal_support",
        kind: "actor",
        label: "Support",
        lifecycle: "drafting",
      }),
    );
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: "action_01CHECK",
        laneId: "pool:intent_01PROCESS::principal_support",
        pool_id: "pool:intent_01PROCESS",
      }),
    );
  });

  it("places a Decision attributed via performed_by in that actor's lane (decided_by ?? performed_by)", async () => {
    // A gateway Decision SHOULD carry `decided_by`, but Señor Doco (and
    // legacy BPMN imports) sometimes wire `performed_by` instead. The lane
    // resolver falls back to `performed_by` so such a Decision lands in its
    // actor's swim lane rather than dropping into "Unassigned" — exactly how
    // `intent` already falls back performed_by ?? owned_by. Without the
    // fallback the Decision below would be Unassigned despite naming Torre.
    const intentId = "intent_01VERIFYPROC";
    const decisionId = "decision_01VERIFY";

    const { client } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Verify the user",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Is the user verified?",
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_torre", name: "Torre", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_VERIFY_INTENT", decisionId, intentId, "serves"),
        // Attributed with performed_by, NOT decided_by.
        edge("edge_VERIFY_ACTOR", decisionId, "principal_torre", "performed_by"),
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "verify" });

    expect(graph.lanes).toContainEqual(
      expect.objectContaining({
        id: `pool:${intentId}::principal_torre`,
        kind: "actor",
        label: "Torre",
      }),
    );
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: decisionId,
        laneId: `pool:${intentId}::principal_torre`,
        pool_id: `pool:${intentId}`,
      }),
    );
  });

  it("loads every lifecycle so the client filter can reveal retired nodes", async () => {
    // Regression: the BPMN loader used to hardcode `<> 'retired'` on its
    // node, principal, and edge queries, so retired nodes never reached
    // the client. The lifecycle filter (Drafting/Asserted/Retired) lives
    // client-side (`visibleLifecycles`) and is the only thing that should
    // hide a lifecycle — pre-filtering on the server makes toggling
    // "Retired" on a no-op, leaving the canvas "So empty". The Graph/List
    // loader (full-graph.server) already returns every lifecycle and lets
    // the client filter; BPMN must do the same.
    const intentId = "intent_01RETIRED";
    const firstId = "action_01RET_A";
    const secondId = "action_01RET_B";

    const { client, captured } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Retired process",
          lifecycle: "retired",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: firstId,
          entity_type: "action",
          summary: "Retired step one",
          lifecycle: "retired",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
        {
          id: secondId,
          entity_type: "action",
          summary: "Retired step two",
          lifecycle: "retired",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
      ],
      principals: [
        {
          id: "principal_retired",
          name: "Retired Actor",
          lifecycle: "retired",
        },
      ],
      users: [],
      edges: [
        edge("edge_07A_INTENT", firstId, intentId, "serves"),
        edge("edge_07B_INTENT", secondId, intentId, "serves"),
        edge("edge_07A_ACTOR", firstId, "principal_retired", "performed_by"),
        edge("edge_07B_ACTOR", secondId, "principal_retired", "performed_by"),
        edge("edge_07FLOW", firstId, secondId, "flows_to"),
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "retired-flow" });

    const nodeQuery = captured.find(
      (q) => /FROM nodes t/i.test(q.sql) && /node_type IN/i.test(q.sql),
    );
    const principalQuery = captured.find((q) => /node_type = 'principal'/i.test(q.sql));
    const edgeQuery = captured.find((q) => /FROM edges/i.test(q.sql));

    // None of the loader's queries may pre-exclude retired — the client
    // lifecycle filter owns that decision.
    expect(nodeQuery?.sql).not.toMatch(/<> 'retired'/);
    expect(principalQuery?.sql).not.toMatch(/<> 'retired'/);
    expect(edgeQuery?.sql).not.toMatch(/<> 'retired'/);

    // And the loader must not drop retired rows in JS either: retired
    // nodes, their flow edges, and a retired Principal's named actor lane
    // all survive to the client.
    expect(graph.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([firstId, secondId]));
    expect(graph.links).toContainEqual(
      expect.objectContaining({ id: "edge_07FLOW", source: firstId, target: secondId }),
    );
    expect(graph.lanes).toContainEqual(
      expect.objectContaining({
        kind: "actor",
        label: "Retired Actor",
        lifecycle: "retired",
      }),
    );
  });

  it("orders actor lanes by when their Actions enter the flow", async () => {
    const intentId = "intent_01PROCESS";
    const stateId = "state_01START";
    const requestId = "action_01REQUEST";
    const presentId = "action_01PRESENT";

    const { client } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Talent seeker pays to activate Torre Reach",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: "decision_01CREDITS",
          entity_type: "decision",
          summary: "Does the user have Reach credits?",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
        {
          id: stateId,
          entity_type: "state",
          summary: "Process started",
          lifecycle: "active",
          created_at: "2026-05-26T00:02:00.000Z",
          data: { kind: "initial" },
        },
        {
          id: requestId,
          entity_type: "action",
          summary: "Requests to activate Torre Reach",
          lifecycle: "active",
          created_at: "2026-05-26T00:03:00.000Z",
          data: {},
        },
        {
          id: presentId,
          entity_type: "action",
          summary: "Presents payment options",
          lifecycle: "active",
          created_at: "2026-05-26T00:04:00.000Z",
          data: {},
        },
      ],
      principals: [
        {
          id: "principal_sud",
          name: "SuD",
          lifecycle: "active",
        },
        {
          id: "principal_talent",
          name: "Talent seeker",
          lifecycle: "active",
        },
      ],
      users: [],
      edges: [
        edge("edge_01DECISION_INTENT", "decision_01CREDITS", intentId, "serves"),
        edge("edge_01STATE_INTENT", stateId, intentId, "serves"),
        edge("edge_01REQUEST_INTENT", requestId, intentId, "serves"),
        edge("edge_01PRESENT_INTENT", presentId, intentId, "serves"),
        edge("edge_01DECIDER", "decision_01CREDITS", "principal_sud", "decided_by"),
        edge("edge_01REQUEST_ACTOR", requestId, "principal_talent", "performed_by"),
        edge("edge_01PRESENT_ACTOR", presentId, "principal_sud", "performed_by"),
        edge("edge_01STATE_TO_REQUEST", stateId, requestId, "flows_to"),
        edge("edge_01REQUEST_TO_PRESENT", requestId, presentId, "flows_to"),
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "activation" });

    const actorLabels = graph.lanes
      .filter((lane) => lane.pool_id === `pool:${intentId}` && lane.kind === "actor")
      .map((lane) => lane.label);

    expect(actorLabels).toEqual(["Talent seeker", "SuD"]);
  });

  it("preserves sequence flow labels for BPMN edge tags", async () => {
    const intentId = "intent_01PROCESS";
    const decisionId = "decision_01ROUTE";
    const yesId = "action_01YES";
    const noId = "action_01NO";

    const { client, captured } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Route yes/no process",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Does the user qualify?",
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
        {
          id: yesId,
          entity_type: "action",
          summary: "Approve request",
          lifecycle: "active",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
        {
          id: noId,
          entity_type: "action",
          summary: "Reject request",
          lifecycle: "active",
          created_at: "2026-05-26T00:03:00.000Z",
          data: {},
        },
      ],
      principals: [
        {
          id: "principal_system",
          name: "System",
          lifecycle: "active",
        },
      ],
      users: [],
      edges: [
        edge("edge_02DECISION_INTENT", decisionId, intentId, "serves"),
        edge("edge_02YES_INTENT", yesId, intentId, "serves"),
        edge("edge_02NO_INTENT", noId, intentId, "serves"),
        edge("edge_02DECIDER", decisionId, "principal_system", "decided_by"),
        edge("edge_02YES_ACTOR", yesId, "principal_system", "performed_by"),
        edge("edge_02NO_ACTOR", noId, "principal_system", "performed_by"),
        edge("edge_02YES", decisionId, yesId, "flows_to", { label: "Yes" }),
        edge("edge_02NO", decisionId, noId, "flows_to", { condition: "No" }),
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "activation" });
    const edgeQuery = captured.find((q) => /FROM edges/i.test(q.sql));

    expect(edgeQuery?.sql).toMatch(/props AS edge_props_json/);
    expect(graph.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: decisionId,
          target: yesId,
          edge_type: "flows_to",
          label: "Yes",
        }),
        expect.objectContaining({
          source: decisionId,
          target: noId,
          edge_type: "flows_to",
          label: "No",
        }),
      ]),
    );
  });

  it("renders flows_to edges as forward BPMN sequence links", async () => {
    const intentId = "intent_01PROCESS";
    const firstId = "action_01FIRST";
    const secondId = "action_01SECOND";

    const { client } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Legacy process",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: firstId,
          entity_type: "action",
          summary: "First step",
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
        {
          id: secondId,
          entity_type: "action",
          summary: "Second step",
          lifecycle: "active",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
      ],
      principals: [
        {
          id: "principal_system",
          name: "System",
          lifecycle: "active",
        },
      ],
      users: [],
      edges: [
        edge("edge_03FIRST_INTENT", firstId, intentId, "serves"),
        edge("edge_03SECOND_INTENT", secondId, intentId, "serves"),
        edge("edge_03FIRST_ACTOR", firstId, "principal_system", "performed_by"),
        edge("edge_03SECOND_ACTOR", secondId, "principal_system", "performed_by"),
        edge("edge_flows_to", firstId, secondId, "flows_to"),
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "process" });

    expect(graph.links).toContainEqual(
      expect.objectContaining({
        id: "edge_flows_to",
        source: firstId,
        target: secondId,
        edge_type: "flows_to",
        href: "/process/edges/edge_flows_to",
      }),
    );
    expect(graph.nodes.find((node) => node.id === secondId)?.bfs_depth).toBeGreaterThan(
      graph.nodes.find((node) => node.id === firstId)?.bfs_depth ?? 0,
    );
  });

  it("carries each link's own lifecycle so the filter can hide retired edges", async () => {
    // The lifecycle filter applies to edges, not just nodes — the loader must
    // select and surface each edge's lifecycle so a retired sequence edge can
    // hide by default and reappear when "Retired" is toggled on.
    const intentId = "intent_01PROCESS";
    const firstId = "action_01FIRST";
    const secondId = "action_01SECOND";

    const { client, captured } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "A process",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: firstId,
          entity_type: "action",
          summary: "First step",
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
        {
          id: secondId,
          entity_type: "action",
          summary: "Second step",
          lifecycle: "active",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_system", name: "System", lifecycle: "active" }],
      users: [],
      edges: [
        { ...edge("edge_live", firstId, secondId, "flows_to"), lifecycle: "active" },
        { ...edge("edge_dead", secondId, firstId, "flows_to"), lifecycle: "retired" },
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "process" });

    const edgeQuery = captured.find((q) => /FROM edges/i.test(q.sql));
    expect(edgeQuery?.sql).toMatch(/lifecycle/i);
    expect(graph.links).toContainEqual(
      expect.objectContaining({ id: "edge_live", lifecycle: "active" }),
    );
    expect(graph.links).toContainEqual(
      expect.objectContaining({ id: "edge_dead", lifecycle: "retired" }),
    );
  });

  it("does not render sequence links from node JSON", async () => {
    const intentId = "intent_01PROCESS";
    const firstId = "action_01FIRST";
    const secondId = "action_01SECOND";
    const thirdId = "action_01THIRD";

    const { client } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Reserved-key process",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: firstId,
          entity_type: "action",
          summary: "First step",
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {
            graph_hint: { target: secondId, label: "next" },
          },
        },
        {
          id: secondId,
          entity_type: "action",
          summary: "Second step",
          lifecycle: "active",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
        {
          id: thirdId,
          entity_type: "action",
          summary: "Third step",
          lifecycle: "active",
          created_at: "2026-05-26T00:03:00.000Z",
          data: {
            graph_hint: { source: secondId },
          },
        },
      ],
      principals: [
        {
          id: "principal_system",
          name: "System",
          lifecycle: "active",
        },
      ],
      users: [],
      edges: [],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "field-flow" });

    expect(graph.links).toEqual([]);
    expect(graph.nodes.find((node) => node.id === secondId)?.bfs_depth).toBeUndefined();
    expect(graph.nodes.find((node) => node.id === thirdId)?.bfs_depth).toBeUndefined();
  });

  it("assigns later sequence targets a greater layout depth even when a loop points back", async () => {
    const intentId = "intent_01PROCESS";
    const decisionId = "decision_01ROUTE";
    const checkoutId = "action_01CHECKOUT";

    const { client } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Talent seeker pays to activate Torre Reach",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Are credits enough for the first day?",
          lifecycle: "active",
          created_at: "2026-05-26T00:07:00.000Z",
          data: {},
        },
        {
          id: checkoutId,
          entity_type: "action",
          summary: "Talent seeker completes Stripe checkout for credits",
          lifecycle: "active",
          created_at: "2026-05-26T00:15:00.000Z",
          data: {},
        },
      ],
      principals: [
        {
          id: "principal_system",
          name: "System",
          lifecycle: "active",
        },
        {
          id: "principal_talent",
          name: "Talent seeker",
          lifecycle: "active",
        },
      ],
      users: [],
      edges: [
        edge("edge_05DECISION_INTENT", decisionId, intentId, "serves"),
        edge("edge_05CHECKOUT_INTENT", checkoutId, intentId, "serves"),
        edge("edge_05DECIDER", decisionId, "principal_system", "decided_by"),
        edge("edge_05CHECKOUT_ACTOR", checkoutId, "principal_talent", "performed_by"),
        edge("edge_05DECISION_TO_CHECKOUT", decisionId, checkoutId, "flows_to"),
        edge("edge_05CHECKOUT_TO_DECISION", checkoutId, decisionId, "flows_to"),
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "activation" });
    const decision = graph.nodes.find((node) => node.id === decisionId);
    const checkout = graph.nodes.find((node) => node.id === checkoutId);

    expect(checkout?.bfs_depth).toBeGreaterThan(decision?.bfs_depth ?? 0);
  });

  it("renders a bounded active-first slice for large Docos", async () => {
    const { client } = makeQueryClient({
      nodes: [
        {
          id: "intent_active",
          entity_type: "intent",
          summary: "Active process",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: "intent_drafting",
          entity_type: "intent",
          summary: "Drafting process",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: "action_active",
          entity_type: "action",
          summary: "Active work",
          lifecycle: "active",
          created_at: "2026-05-26T00:10:00.000Z",
          data: {},
        },
        {
          id: "action_drafting",
          entity_type: "action",
          summary: "Drafting work",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:20:00.000Z",
          data: {},
        },
      ],
      principals: [
        {
          id: "principal_owner",
          name: "Owner",
          lifecycle: "active",
        },
      ],
      users: [],
      edges: [
        edge("edge_06ACTIVE_INTENT", "action_active", "intent_active", "serves"),
        edge("edge_06DRAFTING_INTENT", "action_drafting", "intent_drafting", "serves"),
        edge("edge_06ACTIVE_ACTOR", "action_active", "principal_owner", "performed_by"),
        edge("edge_06DRAFTING_ACTOR", "action_drafting", "principal_owner", "performed_by"),
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", {
      handle: "large",
      nodeLimit: 1,
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(["action_active"]);
    expect(graph.pools.map((pool) => pool.id)).toEqual(["pool:intent_active"]);
    expect(graph.lanes).toHaveLength(1);
    // totalCount is the pre-cap flow-node count (both actions), even though the
    // delivered slice holds one — so the header can say "Showing the latest 1 of 2 steps".
    expect(graph.totalCount).toBe(2);
    expect(graph.nodes).toHaveLength(1);
  });

  it("excludes Reference nodes and their citation edges from the BPMN graph", async () => {
    // References are source/background material, not process steps, so the
    // BPMN perspective doesn't render them — not as document artifacts, and
    // not as the gray dashed "see also" links to the steps that cite them.
    // The loader drops both, so the node cap, PageRank, and layout never see
    // a Reference.
    const intentId = "intent_01PROCESS";
    const actionId = "action_01STEP";
    const referenceId = "reference_01DOC";

    const { client } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Process",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: actionId,
          entity_type: "action",
          summary: "Do the thing",
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
        {
          id: referenceId,
          entity_type: "reference",
          summary: "Background doc",
          lifecycle: "active",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_system", name: "System", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_SERVES", actionId, intentId, "serves"),
        edge("edge_ACTOR", actionId, "principal_system", "performed_by"),
        // The action cites the reference — an association edge, not sequence flow.
        edge("edge_CITES", actionId, referenceId, "relates_to"),
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "proc" });

    // The action still renders; the Reference is gone entirely.
    expect(graph.nodes.map((n) => n.id)).toContain(actionId);
    expect(graph.nodes.map((n) => n.entity_type)).not.toContain("reference");
    expect(graph.nodes.map((n) => n.id)).not.toContain(referenceId);
    // No edge incident to the Reference survives into the rendered links.
    expect(graph.links.some((l) => l.source === referenceId || l.target === referenceId)).toBe(
      false,
    );
  });

  it("keeps fully-disconnected nodes in the Unassigned pool, not an arbitrary intent", async () => {
    // A node with no edges at all serves no intent and reaches none through
    // the graph. The old no-Unassigned policy force-homed such orphans into
    // the oldest intent's pool, which dropped unrelated work into that intent
    // (a real Doco showed crawler steps landing under a "Post a job" goal).
    // Genuine orphans must stay in the real Unassigned pool instead.
    const { client } = makeQueryClient({
      nodes: [
        {
          id: "intent_01GOAL",
          entity_type: "intent",
          summary: "Post a job",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: "action_01CONNECTED",
          entity_type: "action",
          summary: "Serves the goal",
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {},
        },
        {
          id: "action_01ORPHAN",
          entity_type: "action",
          summary: "Spider assembles Torre opportunity payload",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_system", name: "System", lifecycle: "active" }],
      users: [],
      edges: [
        edge("edge_SERVES", "action_01CONNECTED", "intent_01GOAL", "serves"),
        edge("edge_ACTOR", "action_01CONNECTED", "principal_system", "performed_by"),
        // action_01ORPHAN deliberately has no edges at all.
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "jobs" });

    const orphan = graph.nodes.find((n) => n.id === "action_01ORPHAN");
    const connected = graph.nodes.find((n) => n.id === "action_01CONNECTED");
    // The orphan lands in Unassigned — never inside the intent's pool.
    expect(orphan?.pool_id).toBe("pool:unassigned");
    expect(orphan?.pool_id).not.toBe("pool:intent_01GOAL");
    // The connected action still homes into the intent it serves.
    expect(connected?.pool_id).toBe("pool:intent_01GOAL");
    // The Unassigned pool is rendered (and sorts to the bottom).
    expect(graph.pools.map((p) => p.id)).toContain("pool:unassigned");
    expect(graph.pools[graph.pools.length - 1]?.id).toBe("pool:unassigned");
  });
});

describe("computeNearestIntentByNode", () => {
  it("assigns nodes to the nearest connected intent", () => {
    const ranks = new Map([
      ["intent_b", 0.9],
      ["intent_a", 0.1],
    ]);
    const nearest = computeNearestIntentByNode(
      ["intent_a", "intent_b"],
      [
        { source: "intent_a", target: "action_a", edge_type: "serves" },
        { source: "action_a", target: "decision_a", edge_type: "flows_to" },
        { source: "intent_b", target: "action_b", edge_type: "serves" },
      ],
      ranks,
    );

    expect(nearest.get("decision_a")).toBe("intent_a");
    expect(nearest.get("action_b")).toBe("intent_b");
  });

  it("uses PageRank to break equal-distance intent ties", () => {
    const ranks = new Map([
      ["intent_b", 0.9],
      ["intent_a", 0.1],
    ]);
    const nearest = computeNearestIntentByNode(
      ["intent_a", "intent_b"],
      [
        { source: "intent_a", target: "shared", edge_type: "serves" },
        { source: "intent_b", target: "shared", edge_type: "serves" },
      ],
      ranks,
    );

    expect(nearest.get("shared")).toBe("intent_b");
  });
});
