import { describe, expect, it } from "vitest";
import { qualifiedDocoLabel, renderPolicyContextSnippet, workspaceWideLabel } from "../doco-labels";

describe("qualifiedDocoLabel", () => {
  it("prefixes the owner when present", () => {
    expect(qualifiedDocoLabel({ ownerSlug: "torre", handle: "runbook" })).toBe("torre/runbook");
  });

  it("falls back to the bare handle without an owner", () => {
    expect(qualifiedDocoLabel({ ownerSlug: "", handle: "runbook" })).toBe("runbook");
    expect(qualifiedDocoLabel({ ownerSlug: null, handle: "runbook" })).toBe("runbook");
  });
});

describe("workspaceWideLabel", () => {
  it("renders the workspace-wide glob", () => {
    expect(workspaceWideLabel("torre")).toBe("torre/*");
  });
});

describe("renderPolicyContextSnippet", () => {
  it("gives each policy its own /<handle>/policies/<id> link", () => {
    const snippet = renderPolicyContextSnippet("torre/runbook", "runbook", [
      { id: "policy_01HZONE", kind: "suggestion", label: "Keep lane names in business language." },
      { id: "policy_01HZTWO", kind: "deterministic", label: "Requires edge — attributed_to" },
    ]);

    expect(snippet).toContain("Policies for torre/runbook (path=/runbook):");
    // Every line carries the stable, clickable link the agent is told to cite.
    expect(snippet).toContain(
      "  - suggestion: Keep lane names in business language. (link: /runbook/policies/policy_01HZONE)",
    );
    expect(snippet).toContain(
      "  - deterministic: Requires edge — attributed_to (link: /runbook/policies/policy_01HZTWO)",
    );
  });

  it("renders just the header when a Doco has no policies", () => {
    expect(renderPolicyContextSnippet("torre/runbook", "runbook", [])).toBe(
      "Policies for torre/runbook (path=/runbook):",
    );
  });
});
