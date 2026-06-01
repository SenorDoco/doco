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
  // The managed relationship edges (performed_by / decided_by / …) are derived
  // from the node fixtures' `data` fields: capture authors them as first-class
  // edges and the bpmn loader reconstructs the lane fields from those edges,
  // since they no longer live in stored `data` (option (i)).
  const managedEdges = (rows.nodes ?? []).flatMap((n) => {
    const node = n as { id: string; data?: Record<string, unknown> };
    const d = node.data ?? {};
    const out: { from_id: string; edge_type: string; to_id: string }[] = [];
    const push = (edge_type: string, to: unknown) => {
      if (typeof to === "string") out.push({ from_id: node.id, edge_type, to_id: to });
    };
    push("performed_by", d.actor_id);
    push("decided_by", d.decided_by);
    push("has_parent", d.parent_intent_id);
    push("superseded_by", d.superseded_by);
    push("templated_by", d.template_id);
    return out;
  });
  const client: QueryClientLike = {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      captured.push({ sql, params });
      if (/FROM edges/i.test(sql)) {
        // The managed-edge lookup (lane reconstruction) vs. the PageRank/link
        // query are both `FROM edges`; route by the managed query's predicate.
        if (/edge_type = ANY/i.test(sql)) return { rows: managedEdges as T[] };
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

describe("loadBpmnGraph", () => {
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
          data: {
            actor_id: "principal_support",
            intent_ids: ["intent_01PROCESS"],
          },
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
      edges: [],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "refunds" });

    const principalQuery = captured.find((q) => /node_type = 'principal'/i.test(q.sql));
    expect(principalQuery?.sql).toMatch(/COALESCE\(lifecycle, 'asserted'\) <> 'retired'/);
    expect(principalQuery?.sql).not.toMatch(/COALESCE\(lifecycle, 'asserted'\) = 'asserted'/);

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
          data: {
            decided_by: "principal_sud",
            intent_ids: [intentId],
          },
        },
        {
          id: stateId,
          entity_type: "state",
          summary: "Process started",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {
            kind: "initial",
            intent_ids: [intentId],
            sequence_to: [requestId],
          },
        },
        {
          id: requestId,
          entity_type: "action",
          summary: "Requests to activate Torre Reach",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:03:00.000Z",
          data: {
            actor_id: "principal_talent",
            intent_ids: [intentId],
            sequence_to: [presentId],
          },
        },
        {
          id: presentId,
          entity_type: "action",
          summary: "Presents payment options",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:04:00.000Z",
          data: {
            actor_id: "principal_sud",
            intent_ids: [intentId],
          },
        },
      ],
      principals: [
        {
          id: "principal_sud",
          name: "SuD",
          lifecycle: "asserted",
        },
        {
          id: "principal_talent",
          name: "Talent seeker",
          lifecycle: "asserted",
        },
      ],
      users: [],
      edges: [
        { from_id: stateId, to_id: requestId, edge_type: "sequence_flow" },
        { from_id: requestId, to_id: presentId, edge_type: "sequence_flow" },
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
          lifecycle: "asserted",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Does the user qualify?",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {
            decided_by: "principal_system",
            intent_ids: [intentId],
          },
        },
        {
          id: yesId,
          entity_type: "action",
          summary: "Approve request",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {
            actor_id: "principal_system",
            intent_ids: [intentId],
          },
        },
        {
          id: noId,
          entity_type: "action",
          summary: "Reject request",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:03:00.000Z",
          data: {
            actor_id: "principal_system",
            intent_ids: [intentId],
          },
        },
      ],
      principals: [
        {
          id: "principal_system",
          name: "System",
          lifecycle: "asserted",
        },
      ],
      users: [],
      edges: [
        {
          from_id: decisionId,
          to_id: yesId,
          edge_type: "sequence_flow",
          edge_props_json: { label: "Yes" },
        },
        {
          from_id: decisionId,
          to_id: noId,
          edge_type: "sequence_flow",
          edge_props_json: { condition: "No" },
        },
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
          edge_type: "sequence_flow",
          label: "Yes",
        }),
        expect.objectContaining({
          source: decisionId,
          target: noId,
          edge_type: "sequence_flow",
          label: "No",
        }),
      ]),
    );
  });

  it("renders legacy preceded_by edges as forward BPMN sequence links", async () => {
    const intentId = "intent_01PROCESS";
    const firstId = "action_01FIRST";
    const secondId = "action_01SECOND";

    const { client } = makeQueryClient({
      nodes: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Legacy process",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: firstId,
          entity_type: "action",
          summary: "First step",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:01:00.000Z",
          data: {
            actor_id: "principal_system",
            intent_ids: [intentId],
          },
        },
        {
          id: secondId,
          entity_type: "action",
          summary: "Second step",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {
            actor_id: "principal_system",
            intent_ids: [intentId],
          },
        },
      ],
      principals: [
        {
          id: "principal_system",
          name: "System",
          lifecycle: "asserted",
        },
      ],
      users: [],
      edges: [{ id: "edge_legacy", from_id: secondId, to_id: firstId, edge_type: "preceded_by" }],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "legacy" });

    expect(graph.links).toContainEqual(
      expect.objectContaining({
        id: "edge_legacy",
        source: firstId,
        target: secondId,
        edge_type: "sequence_flow",
        href: "/legacy/edges/edge_legacy",
      }),
    );
    expect(graph.nodes.find((node) => node.id === secondId)?.bfs_depth).toBeGreaterThan(
      graph.nodes.find((node) => node.id === firstId)?.bfs_depth ?? 0,
    );
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
          lifecycle: "asserted",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Are credits enough for the first day?",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:07:00.000Z",
          data: {
            decided_by: "principal_system",
            intent_ids: [intentId],
          },
        },
        {
          id: checkoutId,
          entity_type: "action",
          summary: "Talent seeker completes Stripe checkout for credits",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:15:00.000Z",
          data: {
            actor_id: "principal_talent",
            intent_ids: [intentId],
          },
        },
      ],
      principals: [
        {
          id: "principal_system",
          name: "System",
          lifecycle: "asserted",
        },
        {
          id: "principal_talent",
          name: "Talent seeker",
          lifecycle: "asserted",
        },
      ],
      users: [],
      edges: [
        { from_id: decisionId, to_id: checkoutId, edge_type: "sequence_flow" },
        { from_id: checkoutId, to_id: decisionId, edge_type: "sequence_flow" },
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
          lifecycle: "asserted",
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
          lifecycle: "asserted",
          created_at: "2026-05-26T00:10:00.000Z",
          data: {
            actor_id: "principal_owner",
            intent_ids: ["intent_active"],
          },
        },
        {
          id: "action_drafting",
          entity_type: "action",
          summary: "Drafting work",
          lifecycle: "drafting",
          created_at: "2026-05-26T00:20:00.000Z",
          data: {
            actor_id: "principal_owner",
            intent_ids: ["intent_drafting"],
          },
        },
      ],
      principals: [
        {
          id: "principal_owner",
          name: "Owner",
          lifecycle: "asserted",
        },
      ],
      users: [],
      edges: [],
    });

    const graph = await loadBpmnGraph(client, "doco_01", {
      handle: "large",
      nodeLimit: 1,
    });

    expect(graph.nodes.map((node) => node.id)).toEqual(["action_active"]);
    expect(graph.pools.map((pool) => pool.id)).toEqual(["pool:intent_active"]);
    expect(graph.lanes).toHaveLength(1);
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
        { source: "action_a", target: "decision_a", edge_type: "sequence_flow" },
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
