import { describe, expect, it, vi } from "vitest";
import { loadOrgTreeData } from "../org-tree-perspective.server";

describe("loadOrgTreeData", () => {
  it("infers person/agent from the Principal's prose (its name), with no role sub-label", async () => {
    // A principal's only text is its `prose` (the name); the org-tree reads the
    // person/agent signal from it. There is no separate body, so no role label.
    const rows = [
      {
        id: "principal_alex",
        name: "Alexander Torrenegra — Person, CEO and founder",
        lifecycle: "active",
        data: {},
      },
      {
        id: "principal_research",
        name: "Research Agent for synthesis and brief generation",
        lifecycle: "active",
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
        role: null,
      }),
      expect.objectContaining({
        id: "principal_research",
        type: "agent",
        role: null,
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
        name: "Staff Engineer — Vacant, budgeted seat reporting to the Director of Engineering. Open req for a Q3 start.",
        lifecycle: "active",
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
        role: null,
      }),
    );
  });

  it("prefers the explicit `kind` column over prose inference", async () => {
    // A principal that declares `kind` takes its seat type from the column,
    // even when the prose (name) would infer the opposite — the structured
    // field wins.
    const rows = [
      {
        id: "principal_bot",
        name: "Ops Bot — human operator on the platform team",
        lifecycle: "active",
        kind: "agent",
        data: {},
      },
      {
        id: "principal_dana",
        name: "Dana — drafts weekly reports like an AI agent",
        lifecycle: "active",
        kind: "human",
        data: {},
      },
    ];
    const client: Parameters<typeof loadOrgTreeData>[0] = {
      query: async <T>(sql: string) =>
        /FROM edges/i.test(sql) ? { rows: [] as T[] } : { rows: rows as T[] },
    };

    const data = await loadOrgTreeData(client, "doco_acme", "acme");

    expect(data.nodes[0]?.type).toBe("agent"); // kind=agent beats "Human …" prose
    expect(data.nodes[1]?.type).toBe("person"); // kind=human beats "AI agent …" prose
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
              name: "Alex — Person, CEO",
              lifecycle: "active",
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
            rows: [{ from_id: "principal_b", to_id: "principal_a" }] as T[],
          };
        }
        return {
          rows: [
            { id: "principal_a", name: "A — Person", lifecycle: "active", data: {} },
            { id: "principal_b", name: "B — Person", lifecycle: "retired", data: {} },
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
