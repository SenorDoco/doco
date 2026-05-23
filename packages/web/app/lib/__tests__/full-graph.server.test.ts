import { describe, expect, it, vi } from "vitest";
import { loadOverviewGraph } from "../full-graph.server";

interface CapturedQuery {
  sql: string;
  params?: unknown[];
}

interface QueryClientLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

function makeQueryClient(rows: Record<string, unknown[]>) {
  const captured: CapturedQuery[] = [];
  const query = async <T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> => {
    captured.push({ sql, params });
    // Pick the right canned response by what the SQL is asking for.
    if (/FROM synapses/i.test(sql)) {
      return { rows: (rows.synapses ?? []) as T[] };
    }
    return { rows: (rows.entities ?? []) as T[] };
  };
  const client: QueryClientLike = { query };
  return { client, captured, query: vi.fn(query) };
}

describe("loadOverviewGraph", () => {
  it("includes a principals leg scoped via data->>'doco_id'", async () => {
    const { client, captured } = makeQueryClient({
      entities: [
        {
          id: "principal_alice",
          entity_type: "principal",
          name: "alice",
          lifecycle: "active",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      synapses: [],
    });

    const graph = await loadOverviewGraph(client, "doco_acme", { handle: "acme" });

    const entityQuery = captured.find((c) => /FROM principals/i.test(c.sql));
    expect(entityQuery, "principals leg should be present in the UNION").toBeDefined();
    expect(entityQuery?.sql).toMatch(/data->>'doco_id'\s*=\s*\$1/);
    expect(entityQuery?.sql).toMatch(/lifecycle.*=\s*'active'/i);
    expect(entityQuery?.params).toEqual(["doco_acme"]);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({
      id: "principal_alice",
      entity_type: "principal",
      name: "alice",
    });
  });

  it("returns principal nodes alongside neuron nodes", async () => {
    const { client } = makeQueryClient({
      entities: [
        {
          id: "decision_01",
          entity_type: "decision",
          name: null,
          lifecycle: "active",
          created_at: "2026-04-01T00:00:00Z",
        },
        {
          id: "principal_alice",
          entity_type: "principal",
          name: "alice",
          lifecycle: "active",
          created_at: "2026-05-01T00:00:00Z",
        },
      ],
      synapses: [],
    });

    const graph = await loadOverviewGraph(client, "doco_acme", { handle: "acme" });

    const types = graph.nodes.map((n) => n.entity_type).sort();
    expect(types).toEqual(["decision", "principal"]);
  });
});
