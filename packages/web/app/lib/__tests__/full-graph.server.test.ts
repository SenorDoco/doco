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
  it("includes a principals leg scoped by the typed doco_id column", async () => {
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
    expect(entityQuery?.sql).toMatch(/\bdoco_id\s*=\s*\$1/);
    expect(entityQuery?.sql).not.toMatch(/data->>'doco_id'/);
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

  it("loads the first-line neuron name with the base graph nodes", async () => {
    const { client } = makeQueryClient({
      entities: [
        {
          id: "state_01TEST0000000000000000001",
          entity_type: "state",
          name: null,
          label: "Waiting for approval",
          lifecycle: "active",
          created_at: "2026-05-23T20:00:00.000Z",
        },
      ],
      synapses: [],
    });

    const graph = await loadOverviewGraph(client, "doco_01TEST00000000000000000001", {
      handle: "test-doco",
    });

    expect(graph.nodes).toEqual([
      expect.objectContaining({
        id: "state_01TEST0000000000000000001",
        name: "Waiting for approval",
      }),
    ]);
  });

  it("can request a bounded graph slice for large Docos", async () => {
    const { client, captured } = makeQueryClient({
      entities: [
        {
          id: "decision_focus",
          entity_type: "decision",
          name: null,
          label: "Focused decision",
          lifecycle: "drafting",
          created_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      synapses: [],
    });

    await loadOverviewGraph(client, "doco_large", {
      centerId: "decision_focus",
      handle: "large",
      limit: 750,
    });

    const entityQuery = captured.find((c) => /FROM principals/i.test(c.sql));
    expect(entityQuery?.sql).toMatch(/id = \$3 DESC/);
    expect(entityQuery?.sql).toMatch(/LIMIT \$2/);
    expect(entityQuery?.params).toEqual(["doco_large", 750, "decision_focus"]);
  });
});
