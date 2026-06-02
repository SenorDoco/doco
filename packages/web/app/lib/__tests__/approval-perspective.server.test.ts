import { describe, expect, it, vi } from "vitest";
import { loadApprovalPerspectiveData } from "../approval-perspective.server";

describe("loadApprovalPerspectiveData", () => {
  it("loads only proposed nodes with author and proposal timing metadata", async () => {
    const querySpy = vi.fn();
    const client = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        querySpy(sql, params);
        expect(sql).toMatch(/after_json->>'lifecycle'\s*=\s*'drafting'/);
        expect(sql).toMatch(/WHERE lifecycle = 'drafting'/);
        expect(sql).toMatch(/FROM nodes t/);
        expect(sql).toMatch(/resolved_actors AS/);
        expect(sql).toMatch(/created_by_user_id/);
        expect(sql).toMatch(/LEFT JOIN nodes proposed_principal/);
        expect(sql).toMatch(/LEFT JOIN users author ON author\.id = n\.author_id/);
        expect(sql).not.toMatch(/author\.id,\s*n\.created_by/);
        expect(params).toEqual(["doco_acme"]);
        return {
          rows: [
            {
              id: "decision_01TEST",
              entity_type: "decision",
              name: "Approve the new policy",
              lifecycle: "drafting",
              created_at: "2026-05-25T10:00:00.000Z",
              proposed_at: "2026-05-26T12:30:00.000Z",
              author_id: "user_alice",
              author_name: "alice",
            },
          ] as T[],
        };
      },
    };

    const data = await loadApprovalPerspectiveData(client, "doco_acme", "acme");

    expect(querySpy).toHaveBeenCalledOnce();
    expect(data.nodes).toEqual([
      {
        id: "decision_01TEST",
        entity_type: "decision",
        name: "Approve the new policy",
        lifecycle: "drafting",
        created_at: "2026-05-25T10:00:00.000Z",
        proposed_at: "2026-05-26T12:30:00.000Z",
        author_id: "user_alice",
        author_name: "alice",
        href: "/acme/decision/decision_01TEST",
        update_url: "/acme/api/decisions/decision_01TEST.json",
        zoom_href: "/acme/decision/decision_01TEST?dialog=skip",
      },
    ]);
  });

  it("applies a query limit when the page loader supplies one", async () => {
    const client = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        expect(sql).toMatch(/LIMIT \$2/);
        expect(params).toEqual(["doco_acme", 25]);
        return { rows: [] };
      },
    };

    const data = await loadApprovalPerspectiveData(client, "doco_acme", "acme", { limit: 25 });

    expect(data.nodes).toEqual([]);
    expect(data.totalCount).toBe(0);
  });

  it("reports the true total of proposed nodes via a scalar COUNT subquery", async () => {
    const client = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        expect(sql).toMatch(/\(SELECT COUNT\(\*\)/);
        return {
          rows: [
            {
              id: "decision_01",
              entity_type: "decision",
              name: "A proposed decision",
              lifecycle: "drafting",
              created_at: "2026-05-25T10:00:00.000Z",
              proposed_at: null,
              author_id: null,
              author_name: null,
              // pg returns the windowed bigint as a string.
              total_count: "812",
            },
          ] as T[],
        };
      },
    };

    const data = await loadApprovalPerspectiveData(client, "doco_acme", "acme", { limit: 1 });

    expect(data.totalCount).toBe(812);
    expect(data.nodes).toHaveLength(1);
  });
});
