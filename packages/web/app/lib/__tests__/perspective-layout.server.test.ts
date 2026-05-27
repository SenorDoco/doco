import { describe, expect, it } from "vitest";
import {
  markPerspectiveLayoutDirty,
  normalizeChangedEntityIds,
  perspectiveLayoutSnapshotId,
  queryPerspectiveLayoutViewport,
} from "../perspective-layout.server";

interface CapturedQuery {
  sql: string;
  params?: unknown[];
}

interface QueryClientLike {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

function makeQueryClient() {
  const captured: CapturedQuery[] = [];
  const client: QueryClientLike = {
    async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      captured.push({ sql, params });
      if (/INSERT INTO perspective_layout_snapshots/i.test(sql)) {
        return {
          rows: [
            {
              id: params?.[0],
              doco_id: params?.[1],
              perspective_kind: params?.[2],
              layout_version: "1",
              status: "dirty",
              algorithm: "",
              config_hash: "",
              bounds_min_x: null,
              bounds_min_y: null,
              bounds_max_x: null,
              bounds_max_y: null,
              stats: {},
              error: null,
              dirty_at: "2026-05-26T00:00:00.000Z",
              built_at: null,
              updated_at: "2026-05-26T00:00:00.000Z",
            },
          ] as T[],
        };
      }
      if (/FROM perspective_layout_snapshots/i.test(sql)) {
        return {
          rows: [
            {
              id: "perspective_layout_doco_01_graph",
              doco_id: "doco_01",
              perspective_kind: "graph",
              layout_version: "7",
              status: "ready",
              algorithm: "ring-v1",
              config_hash: "abc",
              bounds_min_x: -200,
              bounds_min_y: -100,
              bounds_max_x: 200,
              bounds_max_y: 100,
              stats: { nodes: 1 },
              error: null,
              dirty_at: "2026-05-26T00:00:00.000Z",
              built_at: "2026-05-26T00:01:00.000Z",
              updated_at: "2026-05-26T00:01:00.000Z",
            },
          ] as T[],
        };
      }
      if (/FROM perspective_layout_nodes/i.test(sql)) {
        return {
          rows: [
            {
              entity_id: "decision_01",
              entity_type: "decision",
              x: 0,
              y: 0,
              width: 224,
              height: 91,
              z_index: 0,
              lod_level: 0,
              cluster_id: null,
              layout_data: {},
            },
          ] as T[],
        };
      }
      if (/FROM perspective_layout_edges/i.test(sql)) {
        return {
          rows: [
            {
              source_id: "decision_01",
              target_id: "action_01",
              synapse_type: "enacts",
              min_x: 0,
              min_y: 0,
              max_x: 100,
              max_y: 100,
              path: {},
              layout_data: {},
            },
          ] as T[],
        };
      }
      return { rows: [] };
    },
  };
  return { client, captured };
}

describe("perspective layout index", () => {
  it("builds stable snapshot ids and trims changed ids", () => {
    expect(perspectiveLayoutSnapshotId("doco_01", "Org Tree")).toBe(
      "perspective_layout_doco_01_org_tree",
    );
    expect(normalizeChangedEntityIds([" action_01 ", "", "action_01", "decision_01"])).toEqual([
      "action_01",
      "decision_01",
    ]);
  });

  it("marks one perspective dirty with a mergeable changed-id scope", async () => {
    const { client, captured } = makeQueryClient();

    await markPerspectiveLayoutDirty(client, {
      docoId: "doco_01",
      perspectiveKind: "bpmn",
      changedEntityIds: ["decision_01", "decision_01"],
      reason: "reindex",
    });

    const dirtyScope = captured.find((q) =>
      /INSERT INTO perspective_layout_dirty_scopes/i.test(q.sql),
    );
    expect(dirtyScope?.params).toEqual([
      "doco_01",
      "bpmn",
      "node",
      "decision_01",
      ["decision_01"],
      "reindex",
    ]);
    expect(dirtyScope?.sql).toMatch(/changed_entity_ids = \(/);
    expect(captured.some((q) => /layout_version = layout_version \+ 1/i.test(q.sql))).toBe(true);
  });

  it("queries nodes by viewport and fetches visible edges", async () => {
    const { client, captured } = makeQueryClient();

    const result = await queryPerspectiveLayoutViewport(client, {
      docoId: "doco_01",
      perspectiveKind: "graph",
      minX: -10,
      minY: -20,
      maxX: 300,
      maxY: 200,
      lodLevel: 0,
      limit: 50,
    });

    expect(result.snapshot?.status).toBe("ready");
    expect(result.nodes.map((node) => node.entity_id)).toEqual(["decision_01"]);
    expect(result.edges.map((edge) => edge.synapse_type)).toEqual(["enacts"]);

    const nodesQuery = captured.find((q) => /FROM perspective_layout_nodes/i.test(q.sql));
    expect(nodesQuery?.sql).toMatch(/x \+ width >= \$3/);
    expect(nodesQuery?.params).toEqual([
      "perspective_layout_doco_01_graph",
      0,
      -10,
      300,
      -20,
      200,
      50,
    ]);
  });
});
