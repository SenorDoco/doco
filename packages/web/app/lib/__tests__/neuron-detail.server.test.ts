import { describe, expect, it, vi } from "vitest";
import { loadNeuronDialogDetail } from "../neuron-detail.server";

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    action: { table: "actions", body: false, typeNamedColumn: "action" },
    decision: { table: "decisions", body: false, typeNamedColumn: "decision" },
  },
  DOCO_NEURON_TABLE_BY_TYPE: {
    action: { table: "actions", entityType: "action", body: false },
    decision: { table: "decisions", entityType: "decision", body: false },
  },
  roleAtLeast: () => true,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: vi.fn(async () => "owner"),
}));

const meta = {
  docoId: "doco_01TEST",
  ownerId: "principal_owner",
};

function clientWithRow(row: Record<string, unknown>) {
  return {
    query: async <T>(sql: string): Promise<{ rows: T[] }> => {
      if (sql.includes("WITH input(actor_id)")) return { rows: [] };
      if (sql.includes("FROM synapses")) return { rows: [] };
      if (sql.includes("UNION ALL")) return { rows: [] };
      if (sql.includes("FROM audit_events")) return { rows: [] };
      return { rows: [row as T] };
    },
  };
}

describe("loadNeuronDialogDetail", () => {
  it("keeps Principal name as the dialog primary text", async () => {
    const detail = await loadNeuronDialogDetail(
      clientWithRow({
        id: "principal_01TEST",
        primary_text: "Renan Peixoto",
        body_text: "Person. Head of Engineering. Reports to Alexander Torrenegra (CEO).",
        lifecycle: "accepted",
        raw_json: JSON.stringify({ name: "Renan Peixoto" }),
        created_at: "2026-05-26T17:01:00.000Z",
        updated_at: "2026-05-26T17:01:00.000Z",
      }),
      meta,
      {
        handle: "test-doco",
        entityType: "principal",
        id: "principal_01TEST",
        principalId: "principal_owner",
      },
    );

    expect(detail).toMatchObject({
      summary: "Renan Peixoto",
      name: "Renan Peixoto",
      primary_field: "name",
      primary_text: "Renan Peixoto",
      body_field: "body_md",
      body_text: "Person. Head of Engineering. Reports to Alexander Torrenegra (CEO).",
      body_md: "Person. Head of Engineering. Reports to Alexander Torrenegra (CEO).",
      doco: { handle: "test-doco", href: "/test-doco" },
    });
  });

  it("keeps migrated neurons primary text in their type-named field", async () => {
    const detail = await loadNeuronDialogDetail(
      clientWithRow({
        id: "decision_01TEST",
        primary_text: "Use display labels\n\nRationale follows.",
        body_text: null,
        lifecycle: "accepted",
        raw_json: JSON.stringify({}),
        created_at: "2026-05-26T17:01:00.000Z",
        updated_at: "2026-05-26T17:01:00.000Z",
      }),
      meta,
      {
        handle: "test-doco",
        entityType: "decision",
        id: "decision_01TEST",
        principalId: "principal_owner",
      },
    );

    expect(detail).toMatchObject({
      summary: "Use display labels",
      primary_field: "decision",
      primary_text: "Use display labels\n\nRationale follows.",
      body_field: null,
      body_text: null,
      body_md: "Use display labels\n\nRationale follows.",
    });
  });

  it("includes related neuron lifecycle on synapse edges", async () => {
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("FROM synapses") && sql.includes("from_id = $2")) {
          return {
            rows: [
              {
                to_id: "action_01ACTIVE",
                to_neuron_type: "action",
                synapse_type: "enacts",
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM synapses") && sql.includes("to_id = $2")) {
          return {
            rows: [
              {
                from_id: "action_01RETIRED",
                from_neuron_type: "action",
                synapse_type: "preceded_by",
              },
            ] as T[],
          };
        }
        if (sql.includes("UNION ALL")) {
          return {
            rows: [
              {
                id: "action_01ACTIVE",
                entity_type: "action",
                summary: "Live action",
                name: null,
                lifecycle: "accepted",
              },
              {
                id: "action_01RETIRED",
                entity_type: "action",
                summary: "Retired action",
                name: null,
                lifecycle: "retired",
              },
            ] as T[],
          };
        }
        if (sql.includes("WITH input(actor_id)")) return { rows: [] };
        if (sql.includes("FROM audit_events")) return { rows: [] };
        return {
          rows: [
            {
              id: "decision_01TEST",
              primary_text: "Use lifecycle badges",
              body_text: null,
              lifecycle: "accepted",
              raw_json: JSON.stringify({}),
              created_at: "2026-05-26T17:01:00.000Z",
              updated_at: "2026-05-26T17:01:00.000Z",
            },
          ] as T[],
        };
      },
    };

    const detail = await loadNeuronDialogDetail(client, meta, {
      handle: "test-doco",
      entityType: "decision",
      id: "decision_01TEST",
      principalId: "principal_owner",
    });

    expect(detail?.outgoing[0]).toMatchObject({
      other_id: "action_01ACTIVE",
      other_lifecycle: "accepted",
    });
    expect(detail?.incoming[0]).toMatchObject({
      other_id: "action_01RETIRED",
      other_lifecycle: "retired",
    });
  });

  it("resolves user provenance metadata instead of exposing Principal creator ids", async () => {
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("WITH input(actor_id)")) {
          return {
            rows: [
              {
                actor_id: "principal_01AUTHOR",
                user_id: "user_alice",
                label: "alice",
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM synapses")) return { rows: [] };
        if (sql.includes("UNION ALL")) return { rows: [] };
        if (sql.includes("FROM audit_events")) return { rows: [] };
        return {
          rows: [
            {
              id: "decision_01TEST",
              primary_text: "Use user provenance",
              body_text: null,
              lifecycle: "proposed",
              raw_json: JSON.stringify({
                created_by: "principal_01AUTHOR",
                decided_by: "principal_01AUTHOR",
              }),
              created_at: "2026-05-26T17:01:00.000Z",
              updated_at: "2026-05-26T17:01:00.000Z",
            },
          ] as T[],
        };
      },
    };

    const detail = await loadNeuronDialogDetail(client, meta, {
      handle: "test-doco",
      entityType: "decision",
      id: "decision_01TEST",
      principalId: "principal_owner",
    });

    expect(detail?.frontmatter.created_by).toBe("alice");
    expect(detail?.frontmatter.decided_by).toBe("principal_01AUTHOR");
  });
});
