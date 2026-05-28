import { describe, expect, it, vi } from "vitest";
import { loadApprovalPerspectiveData } from "../approval-perspective.server";

describe("loadApprovalPerspectiveData", () => {
  it("loads only proposed neurons with author and proposal timing metadata", async () => {
    const querySpy = vi.fn();
    const client = {
      async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
        querySpy(sql, params);
        expect(sql).toMatch(/after_json->>'lifecycle'\s*=\s*'proposed'/);
        expect(sql).toMatch(/WHERE lifecycle = 'proposed'/);
        expect(sql).toMatch(/FROM principals/);
        expect(sql).toMatch(/resolved_actors AS/);
        expect(sql).toMatch(/created_by_collaborator_id/);
        expect(sql).toMatch(/LEFT JOIN collaborators author ON author\.id = n\.author_id/);
        expect(sql).not.toMatch(/author\.id,\s*n\.created_by/);
        expect(params).toEqual(["doco_acme"]);
        return {
          rows: [
            {
              id: "decision_01TEST",
              entity_type: "decision",
              name: "Approve the new policy",
              lifecycle: "proposed",
              created_at: "2026-05-25T10:00:00.000Z",
              proposed_at: "2026-05-26T12:30:00.000Z",
              author_id: "collaborator_alice",
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
        lifecycle: "proposed",
        created_at: "2026-05-25T10:00:00.000Z",
        proposed_at: "2026-05-26T12:30:00.000Z",
        author_id: "collaborator_alice",
        author_name: "alice",
        href: "/acme/decision/decision_01TEST",
        update_url: "/acme/api/decisions/decision_01TEST.json",
        zoom_href: "/acme/decision/decision_01TEST?dialog=skip",
      },
    ]);
  });
});
