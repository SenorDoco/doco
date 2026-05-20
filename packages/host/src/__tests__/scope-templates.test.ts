import { describe, expect, it } from "vitest";
import { findScopeTemplate } from "../index.js";

describe("scope templates", () => {
  it("seeds semantic membership for #user-flows", () => {
    const tpl = findScopeTemplate("#user-flows");
    const predicates = tpl?.rules.map((rule) => rule.predicate);

    expect(predicates).toContainEqual({
      kind: "probabilistic",
      spec: "A node belongs in #user-flows only when it describes an end-to-end journey, a designed journey step, or a branch, route, form submission, handoff, or progression through a feature.",
      when_node_type: ["intent", "action", "decision", "reference"],
    });
    expect(predicates).toContainEqual({
      kind: "probabilistic",
      spec: 'Action nodes in #user-flows pass the summary style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.',
      when_node_type: ["action"],
    });
  });

  describe("#business-processes template", () => {
    const tpl = findScopeTemplate("#business-processes");

    it("registers and is reachable via canonical and bare names", () => {
      expect(tpl).toBeDefined();
      expect(findScopeTemplate("business-processes")).toBe(tpl);
      expect(tpl?.name).toBe("#business-processes");
      expect(tpl?.icon).toBe("🏭");
    });

    it("ships drafted lifecycle so authors can sketch incomplete processes", () => {
      expect(tpl?.default_node_lifecycle).toBe("drafted");
    });

    it("allows Intent / Action / Decision / State / Eval / Reference / Rule and excludes Log + Idea", () => {
      const allowlist = tpl?.rules
        .map((r) => r.predicate)
        .find((p) => p?.kind === "requires_node_type");
      expect(allowlist).toEqual({
        kind: "requires_node_type",
        node_types: ["intent", "action", "decision", "state", "eval", "reference", "rule"],
      });
    });

    it("requires Intent.actors and Intent.stakeholders", () => {
      const predicates = tpl?.rules.map((r) => r.predicate);
      expect(predicates).toContainEqual({
        kind: "requires_field",
        fields: ["actors"],
        when_node_type: ["intent"],
      });
      expect(predicates).toContainEqual({
        kind: "requires_field",
        fields: ["stakeholders"],
        when_node_type: ["intent"],
      });
    });

    it("requires Action.actor_id / inputs / outputs and a serves edge to Intent", () => {
      const predicates = tpl?.rules.map((r) => r.predicate);
      expect(predicates).toContainEqual({
        kind: "requires_field",
        fields: ["actor_id"],
        when_node_type: ["action"],
      });
      expect(predicates).toContainEqual({
        kind: "requires_field",
        fields: ["inputs"],
        when_node_type: ["action"],
      });
      expect(predicates).toContainEqual({
        kind: "requires_field",
        fields: ["outputs"],
        when_node_type: ["action"],
      });
      expect(predicates).toContainEqual({
        kind: "requires_edge",
        edge_type: "serves",
        target_node_type: "intent",
        when_node_type: ["action"],
      });
    });

    it("enforces actor_id resolves to a Principal and permits team-roles via human/agent types", () => {
      const predicates = tpl?.rules.map((r) => r.predicate);
      expect(predicates).toContainEqual({
        kind: "requires_field_resolves_to_principal",
        field: "actor_id",
        allowed_principal_types: ["human", "agent"],
        when_node_type: ["action"],
      });
    });

    it("enforces initial + terminal States, terminal-no-successor, follows-locality, summary-uniqueness", () => {
      const predicates = tpl?.rules.map((r) => r.predicate);
      // ≥1 active initial State
      expect(predicates).toContainEqual({
        kind: "count-within-scope",
        scope_ref: "$capture_scope",
        node_type: "state",
        where: { kind: "initial", lifecycle: ["active"] },
        comparator: ">=",
        n: 1,
      });
      // ≥1 active terminal State
      expect(predicates).toContainEqual({
        kind: "count-within-scope",
        scope_ref: "$capture_scope",
        node_type: "state",
        where: { kind: "terminal", lifecycle: ["active"] },
        comparator: ">=",
        n: 1,
      });
      // Terminal States have no successor Action
      expect(predicates).toContainEqual({
        kind: "graph-constraint",
        scope_ref: "$capture_scope",
        graph: "follows",
        op: "degree-bounds",
        where: { kind: "terminal" },
        direction: "in",
        max: 0,
      });
      // follows resolves in scope
      expect(predicates).toContainEqual({
        kind: "graph-constraint",
        scope_ref: "$capture_scope",
        graph: "follows",
        op: "references-resolve-in-scope",
        edge_type: "follows",
      });
      // State.summary unique within scope
      expect(predicates).toContainEqual({
        kind: "unique-within-scope",
        scope_ref: "$capture_scope",
        node_type: "state",
        field: "summary",
      });
    });

    it("seeds graph-completeness: every Intent actor must be an Action.actor_id", () => {
      const predicates = tpl?.rules.map((r) => r.predicate);
      expect(predicates).toContainEqual({
        kind: "graph-completeness",
        scope_ref: "$capture_scope",
        list_field: "actors",
        edge_type: "serves",
        incoming_node_type: "action",
        incoming_field_must_match: "actor_id",
        when_node_type: ["intent"],
      });
    });

    it("requires Eval.target_ref", () => {
      const predicates = tpl?.rules.map((r) => r.predicate);
      expect(predicates).toContainEqual({
        kind: "requires_field",
        fields: ["target_ref"],
        when_node_type: ["eval"],
      });
    });

    it("ships probabilistic gateway/compensation/loop/timer/boundary rules", () => {
      const probSpecs = tpl?.rules
        .map((r) => r.predicate)
        .filter(
          (p): p is { kind: "probabilistic"; spec: string; when_node_type?: string[] } =>
            p?.kind === "probabilistic",
        )
        .map((p) => p.spec);
      // Exhaustive gateway branches
      expect(probSpecs?.some((s) => /default.*else.*otherwise|exhaustive/i.test(s))).toBe(true);
      // Compensation for side-effecting Actions
      expect(probSpecs?.some((s) => /compensation|reversal/i.test(s))).toBe(true);
      // Loops bounded by Decision or Rule
      expect(probSpecs?.some((s) => /retry.*loop|loop.*retr/i.test(s))).toBe(true);
      // Timer-driven Actions
      expect(probSpecs?.some((s) => /timer-driven|scheduled/i.test(s))).toBe(true);
      // Trust-boundary crossings
      expect(probSpecs?.some((s) => /boundary/i.test(s))).toBe(true);
    });

    it("ships guidance rules covering happy-path-first, sub-process invocation, log separation, and handoff explicitness", () => {
      const guidance = tpl?.rules.filter((r) => r.kind === "guidance").map((r) => r.summary) ?? [];
      expect(guidance.some((s) => /happy path first/i.test(s))).toBe(true);
      expect(guidance.some((s) => /sub-processes invoked/i.test(s))).toBe(true);
      expect(guidance.some((s) => /process instances.*recorded runs/i.test(s))).toBe(true);
      expect(guidance.some((s) => /handoffs explicit/i.test(s))).toBe(true);
    });

    it("is NOT auto-installed (opt-in template)", () => {
      expect(tpl?.auto_install).toBeFalsy();
    });
  });
});
