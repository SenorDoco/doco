import { describe, expect, it, vi } from "vitest";
import { loadSlaPerspectiveData } from "../sla-perspective.server";

function makeQueryClient(rows: Record<string, unknown[]>) {
  const query = vi.fn(async (sql: string): Promise<{ rows: unknown[] }> => {
    if (/FROM rules/i.test(sql)) return { rows: rows.rules ?? [] };
    if (/FROM evals/i.test(sql)) return { rows: rows.evals ?? [] };
    if (/FROM reference_entities/i.test(sql)) return { rows: rows.references ?? [] };
    if (/FROM actions/i.test(sql)) return { rows: rows.actions ?? [] };
    if (/FROM decisions/i.test(sql)) return { rows: rows.decisions ?? [] };
    if (/FROM principals/i.test(sql)) return { rows: rows.principals ?? [] };
    if (/FROM synapses/i.test(sql)) return { rows: rows.synapses ?? [] };
    return { rows: [] };
  });
  return {
    query,
    client: {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        void params;
        return (await query(sql)) as { rows: T[] };
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
            owner_id: "principal_platform",
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
      synapses: [
        { from_id: "eval_availability", to_id: "rule_01SLA", synapse_type: "tests" },
        { from_id: "rule_01SLA", to_id: "reference_contract", synapse_type: "source_ref" },
        { from_id: "action_breach", to_id: "rule_01SLA", synapse_type: "gated_by" },
        { from_id: "decision_approval", to_id: "rule_01SLA", synapse_type: "consults" },
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
      synapses: [],
    });

    const data = await loadSlaPerspectiveData(client, "doco_01", "acme-slas");
    expect(data.commitments[0]?.warnings).toEqual(
      expect.arrayContaining(["No owner", "No Eval", "No source Reference", "No remedy"]),
    );
    expect(query.mock.calls.some(([sql]) => /FROM logs/i.test(String(sql)))).toBe(false);
  });
});
