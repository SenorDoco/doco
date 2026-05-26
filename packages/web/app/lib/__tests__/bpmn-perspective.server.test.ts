import { describe, expect, it } from "vitest";
import { loadBpmnGraph } from "../bpmn-perspective.server";

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
            preceded_by: [intentId],
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
            preceded_by: [stateId],
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
            preceded_by: [requestId],
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
        { from_id: stateId, to_id: intentId, synapse_type: "preceded_by" },
        { from_id: requestId, to_id: stateId, synapse_type: "preceded_by" },
        { from_id: presentId, to_id: requestId, synapse_type: "preceded_by" },
      ],
    });

    const graph = await loadBpmnGraph(client, "doco_01", { handle: "activation" });

    const actorLabels = graph.lanes
      .filter((lane) => lane.pool_id === `pool:${intentId}` && lane.kind === "actor")
      .map((lane) => lane.label);

    expect(actorLabels).toEqual(["Talent seeker", "SuD"]);
  });
});
