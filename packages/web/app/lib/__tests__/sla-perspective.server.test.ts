import { describe, expect, it, vi } from "vitest";
import { loadSlaPerspectiveData } from "../sla-perspective.server";

function makeQueryClient(rows: Record<string, unknown[]>) {
  const query = vi.fn(async (sql: string, _params?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (/FROM edges/i.test(sql)) return { rows: rows.edges ?? [] };
    // Per-lifecycle commitment totals (loadNodeLifecycleTotals) — GROUP BY.
    if (/GROUP BY/i.test(sql)) return { rows: rows.lifecycleTotals ?? [] };
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
          lifecycle: "active",
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
          lifecycle: "active",
          created_at: "2026-05-26T00:01:00.000Z",
          data: { last_status: "pass" },
        },
      ],
      references: [
        {
          id: "reference_contract",
          reference: "Customer contract clause 4.2",
          ref_type: "document",
          locator: "https://example.test/contract",
          lifecycle: "active",
          created_at: "2026-05-26T00:02:00.000Z",
          data: {},
        },
      ],
      actions: [
        {
          id: "action_breach",
          action: "Notify customer and open service-credit review",
          lifecycle: "active",
          created_at: "2026-05-26T00:03:00.000Z",
          data: {},
        },
      ],
      decisions: [
        {
          id: "decision_approval",
          decision: "Approved 99.9% monthly checkout SLA",
          lifecycle: "active",
          created_at: "2026-05-26T00:04:00.000Z",
          data: {},
        },
      ],
      principals: [{ id: "principal_platform", name: "Platform Owner", lifecycle: "active" }],
      edges: [
        {
          from_id: "rule_01SLA",
          to_id: "principal_platform",
          edge_type: "attributed_to",
          props: { role: "owned_by" },
        },
        {
          from_id: "eval_availability",
          to_id: "rule_01SLA",
          edge_type: "supports",
          props: { role: "tests" },
        },
        {
          from_id: "rule_01SLA",
          to_id: "reference_contract",
          edge_type: "derived_from",
          props: { role: "source_ref" },
        },
        {
          from_id: "action_breach",
          to_id: "rule_01SLA",
          edge_type: "constrained_by",
          props: { role: "gated_by" },
        },
        {
          from_id: "decision_approval",
          to_id: "rule_01SLA",
          edge_type: "constrained_by",
          props: { role: "consults" },
        },
      ],
    });

    const data = await loadSlaPerspectiveData(client, "doco_01", "acme-slas");
    const c = data.commitments[0];

    expect(c?.title).toBe("Checkout API availability is at least 99.9% monthly.");
    expect(c?.owner?.label).toBe("Platform Owner");
    expect(c?.target).toBe("99.9%");
    expect(c?.measurementWindow).toBe("monthly UTC");
    expect(c?.evals.map((e) => e.label)).toEqual(["monthly checkout availability calculation"]);
    expect(c?.sourceRefs.map((r) => r.label)).toEqual(["Customer contract clause 4.2"]);
    expect(c?.responseActions.map((a) => a.label)).toEqual([
      "Notify customer and open service-credit review",
    ]);
    expect(c?.changeDecisions.map((d) => d.label)).toEqual(["Approved 99.9% monthly checkout SLA"]);
    expect(c?.warnings).not.toContain("No owner");
    expect(c?.warnings).not.toContain("No Eval");
    expect(data.stats.evidenceLinked).toBe(1);
  });

  it("uses the full Rule prose as the commitment title, not just the first line", async () => {
    const { client } = makeQueryClient({
      rules: [
        {
          id: "rule_multiline",
          rule: "Checkout API availability is at least 99.9% monthly.\n\nMeasured over rolling 30-day windows, excluding scheduled maintenance.",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          created_by: null,
          data: { target: "99.9%" },
        },
      ],
      evals: [],
      references: [],
      actions: [],
      decisions: [],
      principals: [],
    });

    const data = await loadSlaPerspectiveData(client, "doco_01", "acme-slas");

    // Perspectives render the full node name, not a first-line truncation.
    expect(data.commitments[0]?.title).toBe(
      "Checkout API availability is at least 99.9% monthly.\n\nMeasured over rolling 30-day windows, excluding scheduled maintenance.",
    );
  });

  it("falls back to a placeholder title when the Rule prose is blank", async () => {
    const { client } = makeQueryClient({
      rules: [
        {
          id: "rule_blank",
          rule: "   ",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          created_by: null,
          data: {},
        },
      ],
      evals: [],
      references: [],
      actions: [],
      decisions: [],
      principals: [],
    });

    const data = await loadSlaPerspectiveData(client, "doco_01", "acme-slas");
    expect(data.commitments[0]?.title).toBe("(untitled SLA commitment)");
  });

  it("surfaces register gaps without reading Logs as evidence", async () => {
    const { client, query } = makeQueryClient({
      rules: [
        {
          id: "rule_gap",
          rule: "Exports complete within 2 hours.",
          lifecycle: "active",
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
          lifecycle: "active",
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

    // The six slice queries carry the LIMIT; the per-lifecycle totals query
    // (GROUP BY, no limit) is excluded — it counts the full domain.
    const sliceCalls = query.mock.calls.filter(
      ([sql]) => /FROM nodes/i.test(String(sql)) && !/GROUP BY/i.test(String(sql)),
    );
    expect(sliceCalls).toHaveLength(6);
    for (const [sql, params] of sliceCalls) {
      expect(String(sql)).toMatch(/LIMIT \$2/);
      expect(params).toEqual(["doco_01", 9]);
    }
  });

  it("reports the true per-lifecycle commitment total via a grouped COUNT, immune to the limit", async () => {
    const { client, query } = makeQueryClient({
      rules: [
        {
          id: "rule_01",
          rule: "Checkout availability is 99.9% monthly.",
          lifecycle: "active",
          created_at: "2026-05-26T00:00:00.000Z",
          created_by: null,
          data: {},
        },
      ],
      // pg returns each bigint as a string; counted before the LIMIT so a mostly
      // retired register still reports its real size once "Retired" is shown.
      lifecycleTotals: [
        { lifecycle: "active", n: "900" },
        { lifecycle: "retired", n: "20" },
      ],
      evals: [],
      references: [],
      actions: [],
      decisions: [],
      principals: [],
      edges: [],
    });

    const data = await loadSlaPerspectiveData(client, "doco_01", "acme-slas", { limit: 1 });

    expect(data.totalByLifecycle).toEqual({ drafting: 0, queued: 0, active: 900, retired: 20 });
    expect(data.stats.commitments).toBe(1);
    const totalsCall = query.mock.calls.find(([sql]) => /GROUP BY/i.test(String(sql)));
    expect(String(totalsCall?.[0])).toMatch(/COUNT\(\*\)::text AS n/);
  });

  it("loads every lifecycle so the client filter can reveal a retired register", async () => {
    // Regression (sibling of BPMN PR #819): every SLA node query hardcoded
    // `<> 'retired'`. Commitments (rules) are filtered client-side by
    // `visibleLifecycles`, so pre-excluding retired made toggling "Retired"
    // on a no-op — a fully-retired register rendered "No SLA commitments
    // match". The enrichment queries (eval/reference/action/decision/
    // principal) drop it too, so a revealed retired commitment resolves its
    // linked evidence and owner instead of bogusly reading empty.
    const { client, query } = makeQueryClient({
      rules: [
        {
          id: "rule_retired",
          rule: "Legacy checkout availability was 99.5% monthly.",
          lifecycle: "retired",
          created_at: "2026-05-26T00:00:00.000Z",
          created_by: null,
          data: {},
        },
      ],
      evals: [],
      references: [],
      actions: [],
      decisions: [],
      principals: [],
      edges: [],
    });

    const data = await loadSlaPerspectiveData(client, "doco_01", "acme-slas");

    const nodeCalls = query.mock.calls.filter(([sql]) => /FROM nodes/i.test(String(sql)));
    // Six enrichment queries (rule/eval/reference/action/decision/principal)
    // plus the per-lifecycle totals query — all loading every lifecycle.
    expect(nodeCalls).toHaveLength(7);
    for (const [sql] of nodeCalls) {
      expect(String(sql)).not.toMatch(/<> 'retired'/);
    }
    // The retired rule survives as a commitment — the client filter owns
    // hiding it.
    expect(data.commitments.map((c) => c.id)).toContain("rule_retired");
  });
});
