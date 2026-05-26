import { describe, expect, it, vi } from "vitest";
import { loadNeuronDialogDetail } from "../neuron-detail.server";

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    decision: { table: "decisions", body: false, typeNamedColumn: "decision" },
  },
  DOCO_NEURON_TABLE_BY_TYPE: {
    decision: { table: "decisions", entityType: "decision", body: false },
  },
  roleAtLeast: () => true,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: vi.fn(async () => "owner"),
}));

vi.mock("~/lib/full-graph.server", () => ({
  loadOverviewNodeDetails: vi.fn(async () => []),
}));

const meta = {
  docoId: "doco_01TEST",
  ownerId: "principal_owner",
  displayName: "Test Doco",
};

function clientWithRow(row: Record<string, unknown>) {
  return {
    query: async <T>(sql: string): Promise<{ rows: T[] }> => {
      if (sql.includes("FROM synapses")) return { rows: [] };
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
        lifecycle: "active",
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
    });
  });

  it("keeps migrated neurons primary text in their type-named field", async () => {
    const detail = await loadNeuronDialogDetail(
      clientWithRow({
        id: "decision_01TEST",
        primary_text: "Use display labels\n\nRationale follows.",
        body_text: null,
        lifecycle: "active",
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
});
