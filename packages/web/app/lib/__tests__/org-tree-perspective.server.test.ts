import { describe, expect, it, vi } from "vitest";
import { loadOrgTreeData } from "../org-tree-perspective.server";

describe("loadOrgTreeData", () => {
  it("derives compact role labels from Principal body prose", async () => {
    const rows = [
      {
        id: "principal_alex",
        name: "Alexander Torrenegra",
        lifecycle: "active",
        body_md: "Person. CEO and top-of-chain - founder.",
        data: {},
      },
      {
        id: "principal_research",
        name: "Research Agent",
        lifecycle: "active",
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
                props: { role: "reports_to" },
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

  it("infers a vacant seat from prose and surfaces it as type `vacant` (distinct from person/agent)", async () => {
    // The org-chart template makes vacant a first-class occupant state; the
    // perspective must distinguish a budgeted-but-empty seat from an
    // undetermined one. Vacant wins even though the prose names the kind of
    // engineer the seat is budgeted for.
    const rows = [
      {
        id: "principal_staff",
        name: "Staff Engineer",
        lifecycle: "active",
        body_md:
          "Vacant — budgeted Staff Engineer seat, reporting to the Director of Engineering. Open req for a Q3 start.",
        data: {},
      },
    ];
    const client: Parameters<typeof loadOrgTreeData>[0] = {
      query: async <T>(sql: string) =>
        /FROM edges/i.test(sql) ? { rows: [] as T[] } : { rows: rows as T[] },
    };

    const data = await loadOrgTreeData(client, "doco_acme", "acme");

    expect(data.nodes[0]).toEqual(
      expect.objectContaining({
        id: "principal_staff",
        type: "vacant",
        // The leading "Vacant —" marker is stripped from the role label.
        role: "budgeted Staff Engineer seat, reporting to the Director of Engineerin...",
      }),
    );
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
    expect(data.totalCount).toBe(0);
    expect(querySpy).toHaveBeenCalledOnce();
  });

  it("reports the true principal total via a scalar COUNT subquery", async () => {
    const client: Parameters<typeof loadOrgTreeData>[0] = {
      async query<T>(sql: string): Promise<{ rows: T[] }> {
        if (/FROM edges/i.test(sql)) return { rows: [] as T[] };
        expect(sql).toMatch(/\(SELECT COUNT\(\*\)/);
        return {
          rows: [
            {
              id: "principal_alex",
              name: "Alex",
              lifecycle: "active",
              body_md: "Person. CEO.",
              data: {},
              // pg returns the windowed bigint as a string.
              total_count: "830",
            },
          ] as T[],
        };
      },
    };

    const data = await loadOrgTreeData(client, "doco_acme", "acme", { limit: 1 });

    expect(data.totalCount).toBe(830);
    expect(data.nodes).toHaveLength(1);
  });

  it("loads retired reporting edges so revealed retired principals keep their lines", async () => {
    // Regression (sibling of BPMN PR #819): the has_parent edge query
    // hardcoded `lifecycle <> 'retired'`. Principals already load at every
    // lifecycle, so toggling "Retired" on reveals retired principals — but
    // their reporting lines vanished because a retired principal's edge is
    // itself retired. layoutOrgTree only draws an edge when both endpoints
    // are visible, so the edge filter belongs to the client, not the server.
    const queries: string[] = [];
    const client: Parameters<typeof loadOrgTreeData>[0] = {
      async query<T>(sql: string): Promise<{ rows: T[] }> {
        queries.push(sql);
        if (/FROM edges/i.test(sql)) {
          return {
            rows: [
              { from_id: "principal_b", to_id: "principal_a", props: { role: "reports_to" } },
            ] as T[],
          };
        }
        return {
          rows: [
            { id: "principal_a", name: "A", lifecycle: "active", body_md: "Person.", data: {} },
            { id: "principal_b", name: "B", lifecycle: "retired", body_md: "Person.", data: {} },
          ] as T[],
        };
      },
    };

    const data = await loadOrgTreeData(client, "doco_acme", "acme");

    const edgeSql = queries.find((sql) => /FROM edges/i.test(sql));
    expect(edgeSql).not.toMatch(/<> 'retired'/);
    // The retired report still resolves its manager so the client can draw
    // the line once "Retired" is toggled on.
    expect(data.nodes.find((n) => n.id === "principal_b")?.reports_to).toBe("principal_a");
  });
});
