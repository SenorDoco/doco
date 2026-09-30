import { describe, expect, it } from "vitest";
import { buildMissingDocoGuidance } from "../missing-doco-guidance.server";

describe("buildMissingDocoGuidance", () => {
  it("sends a missing Doco's creator through the project's Workspace first", () => {
    const g = buildMissingDocoGuidance({
      state: "not_found",
      identifier: "rido",
      host: "https://doco.test",
    });
    const create = g.actions[0];
    expect(create?.explainer).toContain("https://doco.test/new-workspace");
    expect(create?.explainer).not.toContain("/new-doco");
  });

  // Agents never create Workspaces. A not-found Doco must send the agent to
  // the project owner for the Workspace, not tell it to create one itself.
  it("tells the agent a person creates the Workspace, and the agent creates the Doco in it", () => {
    const g = buildMissingDocoGuidance({
      state: "not_found",
      identifier: "rido",
      host: "https://doco.test",
    });
    const create = g.actions[0];
    expect(create?.label).toBe("Create the Doco in the project's Workspace");
    expect(create?.explainer).toContain("doco_create");
    expect(create?.explainer).toMatch(/people create Workspaces, never agents/i);
    expect(create?.explainer).toMatch(/ask the owner to create one/i);
  });
});
