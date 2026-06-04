import { describe, expect, it } from "vitest";
import type { PolicyDraft } from "../capture.server";
import { policyDraftFromForm, policyFormInitialFromData } from "../policy-form";

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
