import { describe, expect, it, vi } from "vitest";
import { loadOrgTreeData } from "../org-tree-perspective.server";

describe("loadOrgTreeData", () => {
  it("derives compact role labels from Principal body prose", async () => {
    const rows = [
      {
        id: "principal_alex",
        name: "Alexander Torrenegra",
        lifecycle: "asserted",
        body_md: "Person. CEO and top-of-chain - founder.",
        data: {},
      },
      {
        id: "principal_research",
        name: "Research Agent",
        lifecycle: "asserted",
        body_md: "AI agent: research synthesis and brief generation.",
        data: {},
      },
    ];
    const client: Parameters<typeof loadOrgTreeData>[0] = {
      query: async <T>(sql: string) => {
        if (/FROM edges/i.test(sql)) {
          return {
            rows: [
              {
                from_id: "principal_research",
                to_id: "principal_alex",
                props: { role: "reports_to", source_field: "reports_to" },
              },
            ] as T[],
          };
        }
        return { rows: rows as T[] };
      },
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

  it("passes a SQL limit when a page budget is supplied", async () => {
    const querySpy = vi.fn();
    const client: Parameters<typeof loadOrgTreeData>[0] = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        querySpy(sql, params);
        expect(sql).toMatch(/LIMIT \$2/);
        expect(params).toEqual(["doco_acme", 3]);
        return { rows: [] };
      },
    };

    const data = await loadOrgTreeData(client, "doco_acme", "acme", { limit: 3 });

    expect(data.nodes).toEqual([]);
    expect(querySpy).toHaveBeenCalledOnce();
  });
});
