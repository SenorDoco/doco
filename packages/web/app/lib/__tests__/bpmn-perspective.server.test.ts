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
      if (/FROM collaborators/i.test(sql)) return { rows: (rows.collaborators ?? []) as T[] };
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
      collaborators: [],
      synapses: [],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "refunds" });

    const principalQuery = captured.find((q) => /FROM principals/i.test(q.sql));
    expect(principalQuery?.sql).toMatch(/COALESCE\(lifecycle, 'active'\) <> 'retired'/);
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
          lifecycle: "active",
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
          lifecycle: "active",
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
          lifecycle: "active",
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
          lifecycle: "active",
        },
        {
          id: "principal_talent",
          name: "Talent seeker",
          lifecycle: "active",
        },
      ],
      collaborators: [],
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
          data: {
            decided_by: "principal_system",
            intent_ids: [intentId],
          },
        },
        {
          id: checkoutId,
          entity_type: "action",
          summary: "Talent seeker completes Stripe checkout for credits",
          lifecycle: "active",
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
          lifecycle: "active",
        },
        {
          id: "principal_talent",
          name: "Talent seeker",
          lifecycle: "active",
        },
      ],
      collaborators: [],
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
