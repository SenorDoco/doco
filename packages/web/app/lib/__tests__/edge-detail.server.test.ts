import { describe, expect, it } from "vitest";
import { loadEdgeDialogDetail } from "../edge-detail.server";

const meta = {
  docoId: "doco_01TEST",
};

describe("loadEdgeDialogDetail", () => {
  it("returns edge metadata with linked endpoint node labels", async () => {
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("FROM edges")) {
          return {
            rows: [
              {
                id: "edge_01TEST",
                from_id: "decision_01FROM",
                from_node_type: "decision",
                to_id: "intent_01TO",
                to_node_type: "intent",
                edge_type: "serves",
                props: { note: "critical" },
                lifecycle: "asserted",
                created_at: "2026-05-30T10:00:00.000Z",
                created_by: "user_alice",
                updated_at: "2026-05-30T10:01:00.000Z",
                retired_at: null,
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM nodes")) {
          return {
            rows: [
              {
                id: "decision_01FROM",
                entity_type: "decision",
                summary: "Pick the runtime",
                name: null,
                lifecycle: "asserted",
                created_at: "2026-05-30T09:00:00.000Z",
              },
              {
                id: "intent_01TO",
                entity_type: "intent",
                summary: "Ship the flow",
                name: null,
                lifecycle: "drafting",
                created_at: "2026-05-30T09:30:00.000Z",
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM edge_versions")) {
          return {
            rows: [
              {
                version: 1,
                op: "create",
                recorded_at: "2026-05-30T10:00:00.000Z",
                actor: "user_alice",
                reason: "test setup",
              },
            ] as T[],
          };
        }
        return { rows: [] };
      },
    };

    const detail = await loadEdgeDialogDetail(client, meta, {
      handle: "test-doco",
      id: "edge_01TEST",
    });

    expect(detail).toMatchObject({
      id: "edge_01TEST",
      edge_type: "serves",
      lifecycle: "asserted",
      href: "/test-doco/edges/edge_01TEST",
      from: {
        id: "decision_01FROM",
        entity_type: "decision",
        summary: "Pick the runtime",
        lifecycle: "asserted",
        href: "/test-doco/decision/decision_01FROM",
      },
      to: {
        id: "intent_01TO",
        entity_type: "intent",
        summary: "Ship the flow",
        lifecycle: "drafting",
        href: "/test-doco/intent/intent_01TO",
      },
      props: { note: "critical" },
      history: [
        expect.objectContaining({
          version: 1,
          op: "create",
          reason: "test setup",
        }),
      ],
    });
  });
});
