import { describe, expect, it } from "vitest";
import { loadEdgeDialogDetail } from "../edge-detail.server";

const meta = {
  docoId: "doco_01TEST",
};

describe("loadEdgeDialogDetail", () => {
  it("returns edge metadata with linked endpoint node labels", async () => {
    const capturedSql: string[] = [];
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        capturedSql.push(sql);
        if (sql.includes("WITH input(actor_id)")) {
          return {
            rows: [
              { actor_id: "user_alice", label: "alice" },
              { actor_id: "user_agent", label: "Señor Doco" },
            ] as T[],
          };
        }
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
                updated_by: "user_agent",
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
                source: "ui",
                metadata: { surface: "website" },
                reason: "test setup",
              },
              {
                version: 2,
                op: "update",
                recorded_at: "2026-05-30T10:05:00.000Z",
                actor: "user_agent",
                source: "ui",
                metadata: { surface: "senor_doco", client: "website" },
                reason: "assistant update",
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
    const versionQuery = capturedSql.find((sql) => sql.includes("FROM edge_versions"));

    expect(versionQuery).toMatch(/LEFT JOIN changesets cs ON cs\.tx_id = v\.tx_id/);
    expect(versionQuery).toMatch(/cs\.source/);
    expect(versionQuery).toMatch(/cs\.metadata/);
    expect(versionQuery).toMatch(/cs\.reason/);
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
      authoring: {
        created: {
          user_id: "user_alice",
          user_label: "alice",
          mechanism: "Website",
        },
        updated: {
          user_id: "user_agent",
          user_label: "Señor Doco",
          mechanism: "Señor Doco on website",
        },
      },
      history: [
        expect.objectContaining({
          version: 1,
          op: "create",
          reason: "test setup",
          mechanism: "Website",
        }),
        expect.objectContaining({
          version: 2,
          op: "update",
          reason: "assistant update",
          mechanism: "Señor Doco on website",
        }),
      ],
    });
  });
});
