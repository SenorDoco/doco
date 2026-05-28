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
      if (/FROM synapses/i.test(sql)) return { rows: (rows.synapses ?? []) as T[] };
      if (/FROM users/i.test(sql)) return { rows: (rows.users ?? []) as T[] };
      if (/FROM principals/i.test(sql)) return { rows: (rows.principals ?? []) as T[] };
      return { rows: (rows.neurons ?? []) as T[] };
    },
  };
  return { client, captured };
}

describe("loadBpmnGraph", () => {
  it("resolves drafting Principals as BPMN actor lanes", async () => {
    const { client, captured } = makeQueryClient({
      neurons: [
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
      synapses: [],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "refunds" });

    const principalQuery = captured.find((q) => /FROM principals/i.test(q.sql));
    expect(principalQuery?.sql).toMatch(/COALESCE\(lifecycle, 'accepted'\) <> 'retired'/);
    expect(principalQuery?.sql).not.toMatch(/COALESCE\(lifecycle, 'accepted'\) = 'accepted'/);

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
      neurons: [
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
          lifecycle: "accepted",
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
          lifecycle: "accepted",
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
          lifecycle: "accepted",
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
          lifecycle: "accepted",
        },
        {
          id: "principal_talent",
          name: "Talent seeker",
          lifecycle: "accepted",
        },
      ],
      users: [],
      synapses: [
        { from_id: stateId, to_id: requestId, synapse_type: "sequence_flow" },
        { from_id: requestId, to_id: presentId, synapse_type: "sequence_flow" },
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
      neurons: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Route yes/no process",
          lifecycle: "accepted",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Does the user qualify?",
          lifecycle: "accepted",
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
          lifecycle: "accepted",
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
          lifecycle: "accepted",
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
          lifecycle: "accepted",
        },
      ],
      users: [],
      synapses: [
        {
          from_id: decisionId,
          to_id: yesId,
          synapse_type: "sequence_flow",
          synapse_props_json: { label: "Yes" },
        },
        {
          from_id: decisionId,
          to_id: noId,
          synapse_type: "sequence_flow",
          synapse_props_json: { condition: "No" },
        },
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "activation" });
    const synapseQuery = captured.find((q) => /FROM synapses/i.test(q.sql));

    expect(synapseQuery?.sql).toMatch(/synapse_props_json/);
    expect(graph.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: decisionId,
          target: yesId,
          synapse_type: "sequence_flow",
          label: "Yes",
        }),
        expect.objectContaining({
          source: decisionId,
          target: noId,
          synapse_type: "sequence_flow",
          label: "No",
        }),
      ]),
    );
  });

  it("assigns later sequence targets a greater layout depth even when a loop points back", async () => {
    const intentId = "intent_01PROCESS";
    const decisionId = "decision_01ROUTE";
    const checkoutId = "action_01CHECKOUT";

    const { client } = makeQueryClient({
      neurons: [
        {
          id: intentId,
          entity_type: "intent",
          summary: "Talent seeker pays to activate Torre Reach",
          lifecycle: "accepted",
          created_at: "2026-05-26T00:00:00.000Z",
          data: {},
        },
        {
          id: decisionId,
          entity_type: "decision",
          summary: "Are credits enough for the first day?",
          lifecycle: "accepted",
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
          lifecycle: "accepted",
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
          lifecycle: "accepted",
        },
        {
          id: "principal_talent",
          name: "Talent seeker",
          lifecycle: "accepted",
        },
      ],
      users: [],
      synapses: [
        { from_id: decisionId, to_id: checkoutId, synapse_type: "sequence_flow" },
        { from_id: checkoutId, to_id: decisionId, synapse_type: "sequence_flow" },
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "activation" });
    const decision = graph.nodes.find((node) => node.id === decisionId);
    const checkout = graph.nodes.find((node) => node.id === checkoutId);

    expect(checkout?.bfs_depth).toBeGreaterThan(decision?.bfs_depth ?? 0);
  });

  it("renders a bounded active-first slice for large Docos", async () => {
    const { client } = makeQueryClient({
      neurons: [
        {
          id: "intent_active",
          entity_type: "intent",
          summary: "Active process",
          lifecycle: "accepted",
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
          lifecycle: "accepted",
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
          lifecycle: "accepted",
        },
      ],
      users: [],
      synapses: [],
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
        { source: "intent_a", target: "action_a", synapse_type: "serves" },
        { source: "action_a", target: "decision_a", synapse_type: "sequence_flow" },
        { source: "intent_b", target: "action_b", synapse_type: "serves" },
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
        { source: "intent_a", target: "shared", synapse_type: "serves" },
        { source: "intent_b", target: "shared", synapse_type: "serves" },
      ],
      ranks,
    );

    expect(nearest.get("shared")).toBe("intent_b");
  });
});
