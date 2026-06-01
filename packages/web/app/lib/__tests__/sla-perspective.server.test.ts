import { describe, expect, it, vi } from "vitest";
import { loadSlaPerspectiveData } from "../sla-perspective.server";

function makeQueryClient(rows: Record<string, unknown[]>) {
  const query = vi.fn(async (sql: string, _params?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (/FROM edges/i.test(sql)) return { rows: rows.edges ?? [] };
    if (/node_type = 'rule'/i.test(sql)) return { rows: rows.rules ?? [] };
    if (/node_type = 'eval'/i.test(sql)) return { rows: rows.evals ?? [] };
    if (/node_type = 'reference'/i.test(sql)) return { rows: rows.references ?? [] };
    if (/node_type = 'action'/i.test(sql)) return { rows: rows.actions ?? [] };
    if (/node_type = 'decision'/i.test(sql)) return { rows: rows.decisions ?? [] };
    if (/node_type = 'principal'/i.test(sql)) return { rows: rows.principals ?? [] };
    return { rows: [] };
  });
  return {
    query,
    client: {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        return (await query(sql, params)) as { rows: T[] };
      },
    },
  };
}

describe("loadSlaPerspectiveData", () => {
  it("renders Rules as commitments enriched by owner, Eval, Reference, Action, and Decision links", async () => {
    const { client } = makeQueryClient({
      rules: [
        {
          id: "rule_01SLA",
          rule: "Checkout API availability is at least 99.9% monthly.",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:00:00.000Z",
          created_by: null,
          data: {
            metric: "successful valid checkout requests",
            target: "99.9%",
            measurement_window: "monthly UTC",
            source_ref: "reference_contract",
            remedy: "10% service credit",
            review_date: "2099-01-01",
          },
        },
      ],
      evals: [
        {
          id: "eval_availability",
          eval: "monthly checkout availability calculation",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:01:00.000Z",
          data: { target_ref: "rule_01SLA", last_status: "pass" },
        },
      ],
      references: [
        {
          id: "reference_contract",
          reference: "Customer contract clause 4.2",
          ref_type: "document",
          locator: "https://example.test/contract",
          title: "Contract clause 4.2",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
      ],
      actions: [
        {
          id: "action_breach",
          action: "Notify customer and open service-credit review",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:03:00.000Z",
          data: {},
        },
      ],
      decisions: [
        {
          id: "decision_approval",
          decision: "Approved 99.9% monthly checkout SLA",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:04:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_platform", name: "Platform Owner", lifecycle: "asserted" }],
      edges: [
        { from_id: "rule_01SLA", to_id: "principal_platform", edge_type: "owned_by" },
        { from_id: "eval_availability", to_id: "rule_01SLA", edge_type: "tests" },
        { from_id: "rule_01SLA", to_id: "reference_contract", edge_type: "source_ref" },
        { from_id: "action_breach", to_id: "rule_01SLA", edge_type: "gated_by" },
        { from_id: "decision_approval", to_id: "rule_01SLA", edge_type: "consults" },
      ],
    });

    const data = await loadSlaPerspectiveData(client, "doco_01", "acme-slas");
    const c = data.commitments[0];

    expect(c?.title).toBe("Checkout API availability is at least 99.9% monthly.");
    expect(c?.owner?.label).toBe("Platform Owner");
    expect(c?.target).toBe("99.9%");
    expect(c?.measurementWindow).toBe("monthly UTC");
    expect(c?.evals.map((e) => e.label)).toEqual(["monthly checkout availability calculation"]);
    expect(c?.sourceRefs.map((r) => r.label)).toEqual(["Contract clause 4.2"]);
    expect(c?.responseActions.map((a) => a.label)).toEqual([
      "Notify customer and open service-credit review",
    ]);
    expect(c?.changeDecisions.map((d) => d.label)).toEqual(["Approved 99.9% monthly checkout SLA"]);
    expect(c?.warnings).not.toContain("No owner");
    expect(c?.warnings).not.toContain("No Eval");
    expect(data.stats.evidenceLinked).toBe(1);
  });

  it("surfaces register gaps without reading Logs as evidence", async () => {
    const { client, query } = makeQueryClient({
      rules: [
        {
          id: "rule_gap",
          rule: "Exports complete within 2 hours.",
          lifecycle: "asserted",
          created_at: "2026-05-26T00:00:00.000Z",
          created_by: null,
          data: { target: "2 hours" },
        },
      ],
      evals: [],
      references: [],
      actions: [],
      decisions: [],
      principals: [],
      logs: [
        {
          id: "log_delivery",
          log: "Export completed",
          lifecycle: "asserted",
        },
      ],
      edges: [],
    });

    const data = await loadSlaPerspectiveData(client, "doco_01", "acme-slas");
    expect(data.commitments[0]?.warnings).toEqual(
      expect.arrayContaining(["No owner", "No Eval", "No source Reference", "No remedy"]),
    );
    expect(query.mock.calls.some(([sql]) => /FROM logs/i.test(String(sql)))).toBe(false);
  });

  it("applies the supplied limit to each node query", async () => {
    const { client, query } = makeQueryClient({
      rules: [],
      evals: [],
      references: [],
      actions: [],
      decisions: [],
      principals: [],
    });

    await loadSlaPerspectiveData(client, "doco_01", "acme-slas", { limit: 9 });

    const nodeCalls = query.mock.calls.filter(([sql]) => /FROM nodes/i.test(String(sql)));
    expect(nodeCalls).toHaveLength(6);
    for (const [sql, params] of nodeCalls) {
      expect(String(sql)).toMatch(/LIMIT \$2/);
      expect(params).toEqual(["doco_01", 9]);
    }
  });
});
