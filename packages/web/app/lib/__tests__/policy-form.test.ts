import { describe, expect, it } from "vitest";
import type { PolicyDraft } from "../capture.server";
import {
  DETERMINISTIC_SUB_KINDS,
  type PolicyFormInitial,
  policyDraftFromForm,
  policyFormInitialFromData,
} from "../policy-form";

function form(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

function draftOf(entries: Record<string, string>): PolicyDraft {
  const d = policyDraftFromForm(form(entries));
  if ("error" in d) throw new Error(`unexpected error: ${d.error}`);
  return d;
}

/** The structured predicate a deterministic draft carries (parsed back out). */
function predicateOf(entries: Record<string, string>): Record<string, unknown> {
  const d = draftOf(entries);
  if (d.kind !== "deterministic" || typeof d.predicate !== "string") {
    throw new Error("expected a deterministic draft with a JSON-string predicate");
  }
  return JSON.parse(d.predicate);
}

/**
 * Re-submit a prefilled form exactly as the edit page would: every `init`
 * field name doubles as its form input name, so feeding `init` straight back
 * through `policyDraftFromForm` reproduces what the browser POSTs on "Save
 * changes". This is the round-trip that must be lossless.
 */
function resubmit(init: PolicyFormInitial): PolicyDraft {
  const f = new FormData();
  for (const [k, v] of Object.entries(init)) {
    if (typeof v === "string" && v.length > 0) f.set(k, v);
    else if (v === true) f.set(k, "on");
  }
  const d = policyDraftFromForm(f);
  if ("error" in d) throw new Error(`unexpected error: ${d.error}`);
  return d;
}

describe("policyDraftFromForm — edge-scoped probabilistic", () => {
  it("builds an edge-scoped draft when edge_type is set, dropping when_node_type", () => {
    const draft = draftOf({
      kind: "probabilistic",
      agent_instruction: "compare the two endpoints",
      edge_type: "supports",
      from_node_type: "action",
      to_node_type: "intent",
      when_node_type: "intent", // ignored once edge-scoped
    });
    expect(draft).toMatchObject({
      kind: "probabilistic",
      agent_instruction: "compare the two endpoints",
      edge_type: "supports",
      from_node_type: "action",
      to_node_type: "intent",
    });
    // Edge `role` is gone — the form never parses or carries one.
    expect("edge_role" in draft).toBe(false);
    expect("when_node_type" in draft).toBe(false);
  });

  it("falls back to a node-scoped draft (when_node_type) when no edge_type is given", () => {
    const draft = draftOf({
      kind: "probabilistic",
      agent_instruction: "judge the node",
      when_node_type: "intent, action",
    });
    expect(draft).toMatchObject({ kind: "probabilistic", when_node_type: ["intent", "action"] });
    expect("edge_type" in draft).toBe(false);
  });

  it("never edge-scopes a suggestion (edge_type is probabilistic-only)", () => {
    const draft = draftOf({
      kind: "suggestion",
      agent_instruction: "guidance prose",
      edge_type: "supports",
    });
    expect("edge_type" in draft).toBe(false);
  });
});

describe("policyFormInitialFromData — edge round-trip", () => {
  it("prefills the edge scoping from a stored edge-scoped predicate", () => {
    const init = policyFormInitialFromData({
      kind: "probabilistic",
      predicate: {
        agent_instruction: "x",
        edge_type: "supports",
        from_node_type: "action",
        to_node_type: "intent",
      },
    });
    expect(init).toMatchObject({
      kind: "probabilistic",
      edge_type: "supports",
      from_node_type: "action",
      to_node_type: "intent",
    });
    // No edge_role field is prefilled — the concept is gone.
    expect("edge_role" in init).toBe(false);
  });

  it("leaves edge fields blank for a node-scoped probabilistic predicate", () => {
    const init = policyFormInitialFromData({
      kind: "probabilistic",
      predicate: { agent_instruction: "x", when_node_type: ["intent"] },
    });
    expect(init.edge_type).toBe("");
    expect(init.from_node_type).toBe("");
    expect(init.to_node_type).toBe("");
  });
});

// Regression for the reported bug: the edit form's check-type menu was missing
// the newer edge-policy sub_kinds (limits_edge, requires_edge_type) plus
// forbids_field_pattern and flow-wiring. Opening one of those policies and
// hitting "Save changes" silently rewrote it to a different predicate, because
// the form rejected the unknown sub_kind. Every deterministic sub_kind the
// engine understands must be (a) a selectable check type, (b) buildable from
// form fields, and (c) lossless across prefill → resubmit.
describe("every deterministic check type is editable (no silent corruption)", () => {
  it("offers all engine sub_kinds as selectable check types", () => {
    // The four that were missing — the heart of the bug.
    for (const sk of [
      "limits_edge",
      "requires_edge_type",
      "forbids_field_pattern",
      "flow-wiring",
    ]) {
      expect(DETERMINISTIC_SUB_KINDS).toContain(sk);
    }
  });

  it("builds a limits_edge predicate (the single-intent ceiling shape)", () => {
    expect(
      predicateOf({
        kind: "deterministic",
        sub_kind: "limits_edge",
        edge_type: "supports",
        target_node_type: "intent",
        direction: "outgoing",
        max_count: "1",
      }),
    ).toEqual({
      sub_kind: "limits_edge",
      edge_type: "supports",
      target_node_type: "intent",
      direction: "outgoing",
      max_count: 1,
    });
  });

  it("builds a requires_edge_type allowlist predicate", () => {
    expect(
      predicateOf({
        kind: "deterministic",
        sub_kind: "requires_edge_type",
        edge_types: "flows_to, supports, attributed_to",
      }),
    ).toEqual({
      sub_kind: "requires_edge_type",
      edge_types: ["flows_to", "supports", "attributed_to"],
    });
  });

  it("builds a forbids_field_pattern predicate", () => {
    expect(
      predicateOf({
        kind: "deterministic",
        sub_kind: "forbids_field_pattern",
        fields: "name, summary",
        pattern: "^TODO",
        flags: "i",
      }),
    ).toEqual({
      sub_kind: "forbids_field_pattern",
      fields: ["name", "summary"],
      pattern: "^TODO",
      flags: "i",
    });
  });

  it("builds a flow-wiring predicate with initial/terminal conditions", () => {
    expect(
      predicateOf({
        kind: "deterministic",
        sub_kind: "flow-wiring",
        edge_type: "flows_to",
        initial_when_field: "stage",
        initial_when_equals: "start",
        terminal_when_field: "stage",
        terminal_when_equals: "end",
      }),
    ).toEqual({
      sub_kind: "flow-wiring",
      edge_type: "flows_to",
      initial_when: { field: "stage", equals: "start" },
      terminal_when: { field: "stage", equals: "end" },
    });
  });

  it("carries the requires_edge enrichments (min_count, direction, exempt)", () => {
    expect(
      predicateOf({
        kind: "deterministic",
        sub_kind: "requires_edge",
        edge_type: "flows_to",
        target_node_type: "action",
        min_count: "2",
        direction: "outgoing",
        exempt_when_other_node_type: "intent",
        when_node_type: "decision",
      }),
    ).toEqual({
      sub_kind: "requires_edge",
      edge_type: "flows_to",
      target_node_type: "action",
      min_count: 2,
      direction: "outgoing",
      exempt_when_other_node_type: "intent",
      when_node_type: ["decision"],
    });
  });

  // The strongest guarantee: a stored predicate, prefilled into the form and
  // re-submitted untouched, must come back byte-identical. This is exactly what
  // "open the policy, click Save" does — and exactly what was corrupting before.
  const ROUND_TRIP: Array<[string, Record<string, unknown>]> = [
    [
      "limits_edge",
      {
        sub_kind: "limits_edge",
        edge_type: "supports",
        target_node_type: "intent",
        direction: "outgoing",
        max_count: 1,
      },
    ],
    [
      "requires_edge_type",
      { sub_kind: "requires_edge_type", edge_types: ["flows_to", "supports", "attributed_to"] },
    ],
    [
      "forbids_field_pattern",
      { sub_kind: "forbids_field_pattern", fields: ["name"], pattern: "^TODO", flags: "i" },
    ],
    [
      "flow-wiring",
      {
        sub_kind: "flow-wiring",
        edge_type: "flows_to",
        initial_when: { field: "stage", equals: "start" },
        terminal_when: { field: "stage", equals: "end" },
      },
    ],
    [
      "requires_edge",
      {
        sub_kind: "requires_edge",
        edge_type: "flows_to",
        target_node_type: "action",
        min_count: 2,
        direction: "incoming",
        exempt_when_other_node_type: "intent",
      },
    ],
    // The exact shape of the process-membership policy in the bug report: an
    // OUTGOING `has_parent` floor with BOTH structural exemptions. The earlier
    // requires_edge case above never exercised `exempt_when_incoming_edge_type`
    // or `exempt_when_field_truthy`, so the prefill silently dropped them on
    // "Save changes" — turning a correctly-exempted floor into one that blocks
    // every top-level and entry-point Action.
    [
      "requires_edge (process membership, both exemptions)",
      {
        sub_kind: "requires_edge",
        edge_type: "has_parent",
        target_node_type: "action",
        direction: "outgoing",
        exempt_when_incoming_edge_type: "has_parent",
        exempt_when_field_truthy: "entry_point",
        when_node_type: ["action", "decision", "state"],
      },
    ],
  ];
  for (const [name, predicate] of ROUND_TRIP) {
    it(`round-trips a stored ${name} predicate unchanged (prefill → resubmit)`, () => {
      const init = policyFormInitialFromData({
        kind: "deterministic",
        predicate,
        on_violation: "block",
      });
      const draft = resubmit(init);
      expect(draft.kind).toBe("deterministic");
      expect(JSON.parse(draft.predicate as string)).toEqual(predicate);
    });
  }
});

describe("policyFormInitialFromData — prefills the new deterministic shapes", () => {
  it("prefills limits_edge (numbers stringified for the inputs)", () => {
    const init = policyFormInitialFromData({
      kind: "deterministic",
      predicate: {
        sub_kind: "limits_edge",
        edge_type: "supports",
        target_node_type: "intent",
        direction: "outgoing",
        max_count: 1,
      },
    });
    expect(init).toMatchObject({
      sub_kind: "limits_edge",
      edge_type: "supports",
      target_node_type: "intent",
      direction: "outgoing",
      max_count: "1",
    });
  });

  it("prefills requires_edge_type edge_types as CSV", () => {
    const init = policyFormInitialFromData({
      kind: "deterministic",
      predicate: { sub_kind: "requires_edge_type", edge_types: ["flows_to", "supports"] },
    });
    expect(init.sub_kind).toBe("requires_edge_type");
    expect(init.edge_types).toBe("flows_to, supports");
  });

  it("prefills the requires_edge structural exemptions (regression: dropped on edit)", () => {
    // The membership floor from the bug report. Before the fix, the prefill
    // hand-listed predicate fields and forgot these two, so opening the policy
    // showed blank inputs and saving erased the exemptions.
    const init = policyFormInitialFromData({
      kind: "deterministic",
      predicate: {
        sub_kind: "requires_edge",
        edge_type: "has_parent",
        target_node_type: "action",
        direction: "outgoing",
        exempt_when_incoming_edge_type: "has_parent",
        exempt_when_field_truthy: "entry_point",
        when_node_type: ["action", "decision", "state"],
      },
    });
    expect(init).toMatchObject({
      sub_kind: "requires_edge",
      edge_type: "has_parent",
      target_node_type: "action",
      direction: "outgoing",
      exempt_when_incoming_edge_type: "has_parent",
      exempt_when_field_truthy: "entry_point",
      when_node_type: "action, decision, state",
    });
  });

  it("prefills flow-wiring initial/terminal conditions", () => {
    const init = policyFormInitialFromData({
      kind: "deterministic",
      predicate: {
        sub_kind: "flow-wiring",
        edge_type: "flows_to",
        initial_when: { field: "stage", equals: "start" },
        terminal_when: { field: "stage", equals: "end" },
      },
    });
    expect(init).toMatchObject({
      sub_kind: "flow-wiring",
      edge_type: "flows_to",
      initial_when_field: "stage",
      initial_when_equals: "start",
      terminal_when_field: "stage",
      terminal_when_equals: "end",
    });
  });
});
