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
});
