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
});
