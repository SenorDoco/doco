import { describe, expect, it } from "vitest";
import { loadOrgTreeData } from "../org-tree-perspective.server";

describe("loadOrgTreeData", () => {
  it("derives compact role labels from Principal body prose", async () => {
    const rows = [
      {
        id: "principal_alex",
        name: "Alexander Torrenegra",
        lifecycle: "accepted",
        body_md: "Person. CEO and top-of-chain - founder.",
        data: {},
      },
      {
        id: "principal_research",
        name: "Research Agent",
        lifecycle: "accepted",
        body_md: "AI agent: research synthesis and brief generation.",
        data: { reports_to: "principal_alex" },
      },
    ];
    const client: Parameters<typeof loadOrgTreeData>[0] = {
      query: async <T>() => ({
        rows: rows as T[],
      }),
    };

    const data = await loadOrgTreeData(client, "doco_acme", "acme");

    expect(data.nodes).toEqual([
      expect.objectContaining({
        id: "principal_alex",
        type: "person",
        role: "CEO and top-of-chain - founder.",
      }),
      expect.objectContaining({
        id: "principal_research",
        type: "agent",
        role: "research synthesis and brief generation.",
        reports_to: "principal_alex",
      }),
    ]);
  });
});
