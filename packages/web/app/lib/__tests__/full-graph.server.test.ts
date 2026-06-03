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
    if (/FROM edges/i.test(sql)) {
      return { rows: (rows.edges ?? []) as T[] };
    }
    return { rows: (rows.entities ?? []) as T[] };
  };
  const client: QueryClientLike = { query };
  return { client, captured, query: vi.fn(query) };
}

describe("loadOverviewGraph", () => {
  it("includes principal nodes scoped by the typed doco_id column", async () => {
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
      edges: [],
    });

    const graph = await loadOverviewGraph(client, "doco_acme", { handle: "acme" });

    const entityQuery = captured.find((c) => /FROM nodes t/i.test(c.sql));
    expect(entityQuery, "nodes query should include the principal discriminator").toBeDefined();
    expect(entityQuery?.sql).toMatch(/\bdoco_id\s*=\s*\$1/);
    expect(entityQuery?.sql).not.toMatch(/data->>'doco_id'/);
    expect(entityQuery?.sql).toMatch(/node_type\s*<>\s*'principal'/i);
    expect(entityQuery?.params).toEqual(["doco_acme"]);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({
      id: "principal_alice",
      entity_type: "principal",
      name: "alice",
    });
  });

  it("returns principal nodes alongside node nodes", async () => {
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
      edges: [],
    });

    const graph = await loadOverviewGraph(client, "doco_acme", { handle: "acme" });

    const types = graph.nodes.map((n) => n.entity_type).sort();
    expect(types).toEqual(["decision", "principal"]);
  });

  it("loads the first-line node name with the base graph nodes", async () => {
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
      edges: [],
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
      edges: [],
    });

    await loadOverviewGraph(client, "doco_large", {
      centerId: "decision_focus",
      handle: "large",
      limit: 750,
    });

    const entityQuery = captured.find((c) => /FROM nodes t/i.test(c.sql));
    expect(entityQuery?.sql).toMatch(/id = \$3 DESC/);
    expect(entityQuery?.sql).toMatch(/LIMIT \$2/);
    expect(entityQuery?.params).toEqual(["doco_large", 750, "decision_focus"]);
  });

  it("uses a shared perspective window when one is provided", async () => {
    const { client, captured } = makeQueryClient({
      entities: [
        {
          id: "decision_focus",
          entity_type: "decision",
          name: null,
          label: "Focused decision",
          lifecycle: "active",
          created_at: "2026-05-01T00:00:00.000Z",
        },
      ],
      edges: [],
    });

    await loadOverviewGraph(client, "doco_large", {
      centerId: "decision_focus",
      handle: "large",
      limit: 750,
      window: {
        focusNodeId: "decision_focus",
        nodeIds: ["decision_focus", "intent_neighbor"],
      },
    });

    const entityQuery = captured.find((c) => /FROM nodes t/i.test(c.sql));
    expect(entityQuery?.sql).toMatch(/id = ANY\(\$2::text\[\]\)/);
    expect(entityQuery?.sql).not.toMatch(/LIMIT \$2/);
    expect(entityQuery?.params).toEqual(["doco_large", ["decision_focus", "intent_neighbor"]]);
  });

  it("returns stable edge ids and hrefs for clickable perspective edges", async () => {
    const { client } = makeQueryClient({
      entities: [
        {
          id: "decision_01",
          entity_type: "decision",
          name: null,
          label: "Pick the runtime",
          lifecycle: "active",
          created_at: "2026-04-01T00:00:00Z",
        },
        {
          id: "intent_01",
          entity_type: "intent",
          name: null,
          label: "Ship the flow",
          lifecycle: "active",
          created_at: "2026-04-01T00:00:00Z",
        },
      ],
      edges: [
        {
          id: "edge_01",
          from_id: "decision_01",
          to_id: "intent_01",
          edge_type: "supports",
        },
      ],
    });

    const graph = await loadOverviewGraph(client, "doco_acme", { handle: "acme" });

    expect(graph.links).toEqual([
      {
        id: "edge_01",
        source: "decision_01",
        target: "intent_01",
        edge_type: "supports",
        href: "/acme/edges/edge_01",
      },
    ]);
  });

  it("reports the true total node count and hasMore for a bounded slice", async () => {
    // The windowed COUNT(*) reflects the full domain (here 750) even though the
    // slice returns one row; pg hands the bigint back as a string.
    const { client, captured } = makeQueryClient({
      entities: [
        {
          id: "decision_focus",
          entity_type: "decision",
          name: null,
          label: "Focused decision",
          lifecycle: "active",
          created_at: "2026-05-01T00:00:00.000Z",
          total_node_count: "750",
        },
      ],
      edges: [],
    });

    const graph = await loadOverviewGraph(client, "doco_large", { handle: "large", limit: 1 });

    const entityQuery = captured.find((c) => /FROM nodes t/i.test(c.sql));
    expect(entityQuery?.sql).toMatch(/\(SELECT COUNT\(\*\)/);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.totalNodeCount).toBe(750);
    expect(graph.hasMore).toBe(true);
  });

  it("reports hasMore=false when every node fits", async () => {
    const { client } = makeQueryClient({
      entities: [
        {
          id: "decision_01",
          entity_type: "decision",
          name: null,
          label: "A",
          lifecycle: "active",
          created_at: "2026-04-01T00:00:00Z",
          total_node_count: "2",
        },
        {
          id: "intent_01",
          entity_type: "intent",
          name: null,
          label: "B",
          lifecycle: "active",
          created_at: "2026-04-01T00:00:00Z",
          total_node_count: "2",
        },
      ],
      edges: [],
    });

    const graph = await loadOverviewGraph(client, "doco_acme", { handle: "acme" });

    expect(graph.totalNodeCount).toBe(2);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.hasMore).toBe(false);
  });
});
