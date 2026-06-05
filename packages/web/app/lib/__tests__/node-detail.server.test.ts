import { describe, expect, it, vi } from "vitest";
import { loadNodeDialogDetail } from "../node-detail.server";

vi.mock("@doco/db", () => ({
  ALL_ENTITY_TABLES: {
    action: { table: "actions", body: false, typeNamedColumn: "action" },
    decision: { table: "decisions", body: false, typeNamedColumn: "decision" },
    // Reference is now an ordinary prose node (no bespoke override); its logical
    // primary field is "reference", like decision's "decision".
    reference: { table: "nodes", body: false, typeNamedColumn: "reference" },
  },
  DOCO_NODE_TABLE_BY_TYPE: {
    action: { table: "actions", entityType: "action", body: false },
    decision: { table: "decisions", entityType: "decision", body: false },
    reference: { table: "nodes", entityType: "reference", body: false },
  },
  roleAtLeast: () => true,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: vi.fn(async () => "owner"),
}));

const meta = {
  docoId: "doco_01TEST",
  ownerId: "principal_owner",
};

function clientWithRow(row: Record<string, unknown>) {
  return {
    query: async <T>(sql: string): Promise<{ rows: T[] }> => {
      if (sql.includes("WITH input(actor_id)")) return { rows: [] };
      if (sql.includes("FROM edges")) return { rows: [] };
      if (sql.includes("UNION ALL")) return { rows: [] };
      if (sql.includes("FROM audit_events")) return { rows: [] };
      if (sql.includes("FROM node_versions")) return { rows: [] };
      return { rows: [row as T] };
    },
  };
}

describe("loadNodeDialogDetail", () => {
  it("keeps Principal name as the dialog primary text", async () => {
    const detail = await loadNodeDialogDetail(
      clientWithRow({
        id: "principal_01TEST",
        primary_text: "Renan Peixoto",
        lifecycle: "active",
        raw_json: JSON.stringify({ name: "Renan Peixoto" }),
        created_at: "2026-05-26T17:01:00.000Z",
        updated_at: "2026-05-26T17:01:00.000Z",
      }),
      meta,
      {
        handle: "test-doco",
        entityType: "principal",
        id: "principal_01TEST",
        principalId: "principal_owner",
      },
    );

    expect(detail).toMatchObject({
      summary: "Renan Peixoto",
      name: "Renan Peixoto",
      primary_field: "name",
      primary_text: "Renan Peixoto",
      doco: { handle: "test-doco", href: "/test-doco" },
    });
  });

  it("keeps migrated nodes primary text in their type-named field", async () => {
    const detail = await loadNodeDialogDetail(
      clientWithRow({
        id: "decision_01TEST",
        primary_text: "Use display labels\n\nRationale follows.",
        body_text: null,
        lifecycle: "active",
        raw_json: JSON.stringify({}),
        created_at: "2026-05-26T17:01:00.000Z",
        updated_at: "2026-05-26T17:01:00.000Z",
      }),
      meta,
      {
        handle: "test-doco",
        entityType: "decision",
        id: "decision_01TEST",
        principalId: "principal_owner",
      },
    );

    expect(detail).toMatchObject({
      summary: "Use display labels",
      primary_field: "decision",
      primary_text: "Use display labels\n\nRationale follows.",
    });
  });

  it("surfaces a PR reference's title as primary_text — no separate body section", async () => {
    // A PR reference's only text is the title in `prose`; the PR body is not
    // stored, so there is no body section.
    const detail = await loadNodeDialogDetail(
      clientWithRow({
        id: "reference_01TEST",
        primary_text: "Fix the retry idempotency key on 409",
        lifecycle: "active",
        raw_json: JSON.stringify({
          ref_type: "url",
          locator: "https://github.com/acme/store/pull/482",
        }),
        locator: "https://github.com/acme/store/pull/482",
        created_at: "2026-05-26T17:01:00.000Z",
        updated_at: "2026-05-26T17:01:00.000Z",
      }),
      meta,
      {
        handle: "test-doco",
        entityType: "reference",
        id: "reference_01TEST",
        principalId: "principal_owner",
      },
    );

    expect(detail).toMatchObject({
      summary: "Fix the retry idempotency key on 409",
      primary_field: "reference",
      primary_text: "Fix the retry idempotency key on 409",
      locator: "https://github.com/acme/store/pull/482",
    });
  });

  it("labels the active stage 'activate' and the queued stage 'queue'", async () => {
    const detail = await loadNodeDialogDetail(
      clientWithRow({
        id: "decision_01TEST",
        primary_text: "Use display labels",
        body_text: null,
        lifecycle: "drafting",
        raw_json: JSON.stringify({}),
        created_at: "2026-05-26T17:01:00.000Z",
        updated_at: "2026-05-26T17:01:00.000Z",
      }),
      meta,
      {
        handle: "test-doco",
        entityType: "decision",
        id: "decision_01TEST",
        principalId: "principal_owner",
      },
    );

    // The clickable stage transitions read as verbs. After the rename, "active"
    // reads as "activate" (not the retired "assert"), and the new "queued"
    // stage reads as "queue".
    const options = detail?.lifecycle_options ?? [];
    expect(options.find((o) => o.value === "active")?.label).toBe("activate");
    expect(options.find((o) => o.value === "queued")?.label).toBe("queue");
    expect(options.map((o) => o.label)).not.toContain("assert");
    // The current stage still reads as its state name, not a verb.
    const drafting = options.find((o) => o.value === "drafting");
    expect(drafting?.current).toBe(true);
    expect(drafting?.label).toBe("drafting");
  });

  it("includes related node lifecycle on edge edges", async () => {
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("FROM edges") && sql.includes("from_id = $2")) {
          return {
            rows: [
              {
                to_id: "action_01ACTIVE",
                to_node_type: "action",
                edge_type: "supports",
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM edges") && sql.includes("to_id = $2")) {
          return {
            rows: [
              {
                from_id: "action_01RETIRED",
                from_node_type: "action",
                edge_type: "flows_to",
              },
            ] as T[],
          };
        }
        if (sql.includes("node_type IN")) {
          return {
            rows: [
              {
                id: "action_01ACTIVE",
                entity_type: "action",
                summary: "Live action",
                name: null,
                lifecycle: "active",
              },
              {
                id: "action_01RETIRED",
                entity_type: "action",
                summary: "Retired action",
                name: null,
                lifecycle: "retired",
              },
            ] as T[],
          };
        }
        if (sql.includes("WITH input(actor_id)")) return { rows: [] };
        if (sql.includes("FROM audit_events")) return { rows: [] };
        return {
          rows: [
            {
              id: "decision_01TEST",
              primary_text: "Use lifecycle badges",
              body_text: null,
              lifecycle: "active",
              raw_json: JSON.stringify({}),
              created_at: "2026-05-26T17:01:00.000Z",
              updated_at: "2026-05-26T17:01:00.000Z",
            },
          ] as T[],
        };
      },
    };

    const detail = await loadNodeDialogDetail(client, meta, {
      handle: "test-doco",
      entityType: "decision",
      id: "decision_01TEST",
      principalId: "principal_owner",
    });

    expect(detail?.outgoing[0]).toMatchObject({
      other_id: "action_01ACTIVE",
      other_lifecycle: "active",
    });
    expect(detail?.incoming[0]).toMatchObject({
      other_id: "action_01RETIRED",
      other_lifecycle: "retired",
    });
  });

  it("exposes the edge's own id, lifecycle, and page href so the row opens the edge dialog", async () => {
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("FROM edges") && sql.includes("from_id = $2")) {
          return {
            rows: [
              {
                edge_id: "edge_01OUT",
                edge_lifecycle: "active",
                to_id: "action_01ACTIVE",
                to_node_type: "action",
                edge_type: "supports",
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM edges") && sql.includes("to_id = $2")) {
          return {
            rows: [
              {
                edge_id: "edge_01IN",
                edge_lifecycle: "drafting",
                from_id: "action_01RETIRED",
                from_node_type: "action",
                edge_type: "flows_to",
              },
            ] as T[],
          };
        }
        if (sql.includes("node_type IN")) {
          return {
            rows: [
              {
                id: "action_01ACTIVE",
                entity_type: "action",
                summary: "Live action",
                name: null,
                lifecycle: "active",
              },
              {
                id: "action_01RETIRED",
                entity_type: "action",
                summary: "Retired action",
                name: null,
                lifecycle: "retired",
              },
            ] as T[],
          };
        }
        if (sql.includes("WITH input(actor_id)")) return { rows: [] };
        if (sql.includes("FROM audit_events")) return { rows: [] };
        return {
          rows: [
            {
              id: "decision_01TEST",
              primary_text: "Use lifecycle badges",
              body_text: null,
              lifecycle: "active",
              raw_json: JSON.stringify({}),
              created_at: "2026-05-26T17:01:00.000Z",
              updated_at: "2026-05-26T17:01:00.000Z",
            },
          ] as T[],
        };
      },
    };

    const detail = await loadNodeDialogDetail(client, meta, {
      handle: "test-doco",
      entityType: "decision",
      id: "decision_01TEST",
      principalId: "principal_owner",
    });

    expect(detail?.outgoing[0]).toMatchObject({
      edge_id: "edge_01OUT",
      edge_lifecycle: "active",
      edge_href: "/test-doco/edges/edge_01OUT",
      other_id: "action_01ACTIVE",
    });
    expect(detail?.incoming[0]).toMatchObject({
      edge_id: "edge_01IN",
      edge_lifecycle: "drafting",
      edge_href: "/test-doco/edges/edge_01IN",
      other_id: "action_01RETIRED",
    });
  });

  it("does not include BPMN sequence links unless edge rows exist", async () => {
    const decisionId = "decision_01ROUTE";
    const priorId = "action_01PRIOR";
    const flexibleId = "action_01FLEXIBLE";
    const internshipId = "action_01INTERNSHIP";
    const fullTimeId = "action_01FULLTIME";
    const principalId = "principal_01USER";
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("jsonb_array_elements")) return { rows: [] };
        if (sql.includes("FROM edges") && sql.includes("from_id = $2")) {
          return {
            rows: [
              {
                to_id: principalId,
                to_node_type: "principal",
                edge_type: "attributed_to",
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM edges") && sql.includes("to_id = $2")) return { rows: [] };
        if (sql.includes("node_type IN")) {
          return {
            rows: [
              {
                id: priorId,
                entity_type: "action",
                summary: "Prior step",
                name: null,
                lifecycle: "active",
              },
              {
                id: flexibleId,
                entity_type: "action",
                summary: "Flexible path",
                name: null,
                lifecycle: "active",
              },
              {
                id: internshipId,
                entity_type: "action",
                summary: "Internship path",
                name: null,
                lifecycle: "active",
              },
              {
                id: fullTimeId,
                entity_type: "action",
                summary: "Full-time path",
                name: null,
                lifecycle: "active",
              },
              {
                id: principalId,
                entity_type: "principal",
                summary: "User",
                name: "User",
                lifecycle: "active",
              },
            ] as T[],
          };
        }
        if (sql.includes("WITH input(actor_id)")) return { rows: [] };
        if (sql.includes("FROM audit_events")) return { rows: [] };
        if (sql.includes("FROM node_versions")) return { rows: [] };
        return {
          rows: [
            {
              id: decisionId,
              primary_text: "BPMN gateway\nin lane User",
              body_text: null,
              lifecycle: "active",
              raw_json: JSON.stringify({
                sequence_to: [
                  { target: flexibleId, label: "Flexible" },
                  { target: internshipId, label: "Internship" },
                ],
              }),
              created_at: "2026-05-31T17:38:00.000Z",
              updated_at: "2026-05-31T17:45:00.000Z",
            },
          ] as T[],
        };
      },
    };

    const detail = await loadNodeDialogDetail(client, meta, {
      handle: "test-doco",
      entityType: "decision",
      id: decisionId,
      principalId: "principal_owner",
    });

    expect(detail?.incoming).toEqual([]);
    expect(detail?.outgoing).toEqual([
      expect.objectContaining({
        edge_type: "attributed_to",
        other_id: principalId,
      }),
    ]);
  });

  it("resolves user provenance metadata instead of exposing Principal creator ids", async () => {
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("WITH input(actor_id)")) {
          return {
            rows: [
              {
                actor_id: "principal_01AUTHOR",
                user_id: "user_alice",
                label: "alice",
              },
            ] as T[],
          };
        }
        if (sql.includes("FROM edges")) return { rows: [] };
        if (sql.includes("UNION ALL")) return { rows: [] };
        if (sql.includes("FROM audit_events")) return { rows: [] };
        return {
          rows: [
            {
              id: "decision_01TEST",
              primary_text: "Use user provenance",
              body_text: null,
              lifecycle: "drafting",
              raw_json: JSON.stringify({
                created_by: "principal_01AUTHOR",
                decided_by: "principal_01AUTHOR",
              }),
              created_at: "2026-05-26T17:01:00.000Z",
              updated_at: "2026-05-26T17:01:00.000Z",
            },
          ] as T[],
        };
      },
    };

    const detail = await loadNodeDialogDetail(client, meta, {
      handle: "test-doco",
      entityType: "decision",
      id: "decision_01TEST",
      principalId: "principal_owner",
    });

    expect(detail?.frontmatter.created_by).toBe("alice");
    expect(detail?.frontmatter.decided_by).toBe("principal_01AUTHOR");
  });

  it("loads created/updated authoring provenance for the dialog", async () => {
    const capturedSql: string[] = [];
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        capturedSql.push(sql);
        if (sql.includes("WITH input(actor_id)")) {
          return {
            rows: [
              { actor_id: "user_alice", user_id: "user_alice", label: "alice" },
              { actor_id: "user_agent", user_id: "user_agent", label: "Señor Doco" },
            ] as T[],
          };
        }
        if (sql.includes("FROM edges")) return { rows: [] };
        if (sql.includes("UNION ALL")) return { rows: [] };
        if (sql.includes("FROM audit_events")) return { rows: [] };
        if (sql.includes("FROM node_versions")) {
          return {
            rows: [
              {
                kind: "created",
                actor: "user_alice",
                source: "ui",
                metadata: { surface: "website" },
                recorded_at: "2026-05-26T17:01:00.000Z",
              },
              {
                kind: "updated",
                actor: "user_agent",
                source: "ui",
                metadata: { surface: "senor_doco", client: "website" },
                recorded_at: "2026-05-26T17:04:00.000Z",
              },
            ] as T[],
          };
        }
        return {
          rows: [
            {
              id: "decision_01TEST",
              primary_text: "Show provenance in dialogs",
              body_text: null,
              lifecycle: "active",
              raw_json: JSON.stringify({
                created_by: "user_alice",
                updated_by: "user_agent",
              }),
              created_at: "2026-05-26T17:01:00.000Z",
              updated_at: "2026-05-26T17:04:00.000Z",
              created_by: "user_alice",
              updated_by: "user_agent",
            },
          ] as T[],
        };
      },
    };

    const detail = await loadNodeDialogDetail(client, meta, {
      handle: "test-doco",
      entityType: "decision",
      id: "decision_01TEST",
      principalId: "principal_owner",
    });
    const actorLabelQuery = capturedSql.find((sql) => sql.includes("WITH input(actor_id)"));

    expect(actorLabelQuery).toContain("left(i.actor_id, 5)");
    expect(actorLabelQuery).toContain("data->>'name'");
    expect(detail?.authoring.created).toMatchObject({
      user_id: "user_alice",
      user_label: "alice",
      mechanism: "Website",
      at: "2026-05-26T17:01:00.000Z",
    });
    expect(detail?.authoring.updated).toMatchObject({
      user_id: "user_agent",
      user_label: "Señor Doco",
      mechanism: "Señor Doco on website",
      at: "2026-05-26T17:04:00.000Z",
    });
  });

  it("surfaces the node locator and connected github repo for permalinking", async () => {
    const client = {
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        if (sql.includes("github_integration")) {
          return {
            rows: [
              { gh: { connections: [{ repo: "torrenegra/Doco", installation_id: 1 }] } },
            ] as T[],
          };
        }
        if (sql.includes("WITH input(actor_id)")) return { rows: [] };
        if (sql.includes("FROM edges")) return { rows: [] };
        if (sql.includes("FROM audit_events")) return { rows: [] };
        if (sql.includes("FROM node_versions")) return { rows: [] };
        return {
          rows: [
            {
              id: "decision_01TEST",
              primary_text: "Implementing code",
              body_text: null,
              lifecycle: "active",
              locator: "packages/web/app/lib/foo.ts:42",
              raw_json: JSON.stringify({}),
              created_at: "2026-05-26T17:01:00.000Z",
              updated_at: "2026-05-26T17:01:00.000Z",
            },
          ] as T[],
        };
      },
    };

    const detail = await loadNodeDialogDetail(client, meta, {
      handle: "test-doco",
      entityType: "decision",
      id: "decision_01TEST",
      principalId: "principal_owner",
    });

    expect(detail?.locator).toBe("packages/web/app/lib/foo.ts:42");
    expect(detail?.github_repo).toBe("torrenegra/Doco");
  });
});
