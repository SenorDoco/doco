import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  requireDocoTypeWritesForRequest: vi.fn(),
  captureFn: vi.fn(),
  captureEdge: vi.fn(),
  edgeExists: vi.fn(),
  retireActiveEdgesRequest: vi.fn(),
  getEntity: vi.fn(),
  withClient: vi.fn(),
  updateEntity: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getEntity: mocks.getEntity,
  withClient: mocks.withClient,
}));

vi.mock("~/lib/authoring-source.server", () => ({
  authoringContextForRequest: vi.fn(async () => ({})),
}));

vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
  requireDocoTypeWritesForRequest: mocks.requireDocoTypeWritesForRequest,
}));

vi.mock("~/lib/edge-capture.server", () => ({
  captureEdge: mocks.captureEdge,
  edgeExists: mocks.edgeExists,
  retireActiveEdgesRequest: mocks.retireActiveEdgesRequest,
}));

vi.mock("~/lib/node-capture-registry.server", () => ({
  CAPTURE_REGISTRY_BY_ENTITY_TYPE: {
    decision: {
      entityType: "decision",
      captureFn: mocks.captureFn,
    },
  },
}));

vi.mock("~/lib/capture.server", () => ({
  updateEntity: mocks.updateEntity,
}));

import { action } from "../$docoHandle.api.changesets[.]json";

function changesetRequest(body: Record<string, unknown>): Request {
  return new Request("https://doco.test/acme/api/changesets.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("changesets write gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForRead.mockResolvedValue({
      dir: "/tmp/docos/acme",
      docoSlug: "acme",
      ownerSlug: "acme",
      me: { id: "user_author", username: "alice" },
      meta: { ownerId: "workspace_acme", docoId: "doco_acme" },
    });
    mocks.requireDocoTypeWritesForRequest.mockResolvedValue(null);
    mocks.captureFn.mockResolvedValue({ ok: true, id: "decision_01NEW", footer_lines: [] });
    mocks.edgeExists.mockResolvedValue(false);
    mocks.captureEdge.mockResolvedValue({
      ok: true,
      id: "edge_01NEW",
      footer_lines: [],
    });
    mocks.retireActiveEdgesRequest.mockResolvedValue({ retired: 0, footer_lines: [] });
    mocks.updateEntity.mockResolvedValue({
      ok: true,
      id: "decision_0123456789ABCDEFGHJKMNPQRS",
      path: "",
      footer_lines: [],
      duration_ms: 0,
      changed: ["lifecycle"],
    });
  });

  it("activate transitions a node to active via updateEntity", async () => {
    const response = await action({
      request: changesetRequest({
        operations: [{ op: "activate", target: "decision_0123456789ABCDEFGHJKMNPQRS" }],
      }),
      params: { docoHandle: "acme" },
    });
    expect(response.status).toBe(200);
    expect(mocks.requireDocoTypeWritesForRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      "user_author",
      expect.arrayContaining(["decision"]),
      "apply this changeset",
    );
    expect(mocks.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "decision",
        pluralDir: "decisions",
        id: "decision_0123456789ABCDEFGHJKMNPQRS",
        patch: { lifecycle: "active" },
      }),
    );
  });

  it("queue transitions a node to queued via updateEntity", async () => {
    const response = await action({
      request: changesetRequest({
        operations: [{ op: "queue", target: "decision_0123456789ABCDEFGHJKMNPQRS" }],
      }),
      params: { docoHandle: "acme" },
    });
    expect(response.status).toBe(200);
    expect(mocks.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "decision",
        pluralDir: "decisions",
        id: "decision_0123456789ABCDEFGHJKMNPQRS",
        patch: { lifecycle: "queued" },
      }),
    );
  });

  it("retire with retire_active_edges cascades the node's active edges before demoting it", async () => {
    mocks.retireActiveEdgesRequest.mockResolvedValue({
      retired: 2,
      footer_lines: ["retired 2 edges"],
    });
    const response = await action({
      request: changesetRequest({
        operations: [
          {
            op: "retire",
            target: "decision_0123456789ABCDEFGHJKMNPQRS",
            retire_active_edges: true,
          },
        ],
      }),
      params: { docoHandle: "acme" },
    });
    expect(response.status).toBe(200);
    expect(mocks.retireActiveEdgesRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        docoId: "doco_acme",
        nodeId: "decision_0123456789ABCDEFGHJKMNPQRS",
      }),
    );
    expect(mocks.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { lifecycle: "retired" } }),
    );
  });

  it("retire WITHOUT the flag leaves edges untouched (cascade is opt-in, default off)", async () => {
    const response = await action({
      request: changesetRequest({
        operations: [{ op: "retire", target: "decision_0123456789ABCDEFGHJKMNPQRS" }],
      }),
      params: { docoHandle: "acme" },
    });
    expect(response.status).toBe(200);
    expect(mocks.retireActiveEdgesRequest).not.toHaveBeenCalled();
  });

  it("relate forwards an explicit edge lifecycle to captureEdge", async () => {
    const response = await action({
      request: changesetRequest({
        operations: [
          {
            op: "relate",
            relation_kind: "supports",
            from: "decision_0123456789ABCDEFGHJKMNPQRS",
            to: "intent_0123456789ABCDEFGHJKMNPQRS",
            lifecycle: "queued",
          },
        ],
      }),
      params: { docoHandle: "acme" },
    });
    expect(response.status).toBe(200);
    expect(mocks.captureEdge).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "queued" }),
    );
  });

  it("rejects the former 'assert' op — renamed to 'activate', no backwards compat", async () => {
    const response = await action({
      request: changesetRequest({
        operations: [{ op: "assert", target: "decision_0123456789ABCDEFGHJKMNPQRS" }],
      }),
      params: { docoHandle: "acme" },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('Unknown operation "assert"');
    expect(mocks.updateEntity).not.toHaveBeenCalled();
  });

  it("retire transitions a node to retired", async () => {
    await action({
      request: changesetRequest({
        operations: [{ op: "retire", target: "decision_0123456789ABCDEFGHJKMNPQRS" }],
      }),
      params: { docoHandle: "acme" },
    });
    expect(mocks.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "decision_0123456789ABCDEFGHJKMNPQRS",
        patch: { lifecycle: "retired" },
      }),
    );
  });

  it("supersede creates the replacement and retires the old node pointing at it", async () => {
    const response = await action({
      request: changesetRequest({
        operations: [
          {
            op: "supersede",
            target: "decision_0123456789ABCDEFGHJKMNPQRS",
            entity_type: "decision",
            body: { decision: "Revised", question: "Why?" },
          },
        ],
      }),
      params: { docoHandle: "acme" },
    });
    const body = (await response.json()) as { ok: boolean; results: Array<{ id?: string }> };
    expect(response.status).toBe(200);
    // New node created…
    expect(mocks.captureFn).toHaveBeenCalled();
    // …linked to the old node with a first-class `replaces` edge…
    expect(mocks.captureEdge).toHaveBeenCalledWith(
      expect.objectContaining({ edgeType: "replaces" }),
    );
    // …and the old node retired (lifecycle only — the link is the edge).
    expect(mocks.updateEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "decision_0123456789ABCDEFGHJKMNPQRS",
        patch: { lifecycle: "retired" },
      }),
    );
    expect(body.results[0].id).toBe("decision_01NEW");
  });

  it("preflights the node type for assert/retire/supersede targets", async () => {
    await action({
      request: changesetRequest({
        operations: [
          { op: "retire", target: "action_0123456789ABCDEFGHJKMNPQRS" },
          {
            op: "supersede",
            target: "decision_0123456789ABCDEFGHJKMNPQRS",
            entity_type: "decision",
            body: { decision: "x", question: "y" },
          },
        ],
      }),
      params: { docoHandle: "acme" },
    });
    expect(mocks.requireDocoTypeWritesForRequest).toHaveBeenCalledWith(
      expect.any(Request),
      expect.anything(),
      "user_author",
      expect.arrayContaining(["action", "decision"]),
      "apply this changeset",
    );
  });

  it("preflights every node and relation type touched by the batch", async () => {
    await action({
      request: changesetRequest({
        operations: [
          {
            op: "append",
            entity_type: "decision",
            alias: "gateway",
            after: "state_01BEFORE",
            relation_kind: "flows_to",
            body: { decision: "Choose a path", question: "Which path?" },
          },
          {
            op: "relate",
            relation_kind: "supports",
            from: "$gateway",
            to: "intent_01ROOT",
          },
        ],
      }),
      params: { docoHandle: "acme" },
    });

    expect(mocks.requireDocoTypeWritesForRequest).toHaveBeenCalledWith(
      expect.any(Request),
      { ownerId: "workspace_acme", docoId: "doco_acme" },
      "user_author",
      expect.arrayContaining(["decision", "flows_to", "supports"]),
      "apply this changeset",
    );
  });

  it("drops a `role` prop on a relate op — edge `role` is gone, so the catalog rejects it", async () => {
    await action({
      request: changesetRequest({
        operations: [
          {
            op: "relate",
            relation_kind: "attributed_to",
            from: "action_01A",
            to: "principal_01B",
            relation_props: { role: "performed_by" },
          },
        ],
      }),
      params: { docoHandle: "acme" },
    });

    // `role` is no longer a prop any relation accepts (the relation catalog
    // dropped it), so `relationProps` filters it out: the edge is created with
    // NO role prop. Its meaning rides on the edge type + endpoints
    // (`attributed_to` from an Action to a Principal IS the performer link).
    expect(mocks.captureEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        edgeType: "attributed_to",
        fromId: "action_01A",
        toId: "principal_01B",
        label: null,
        condition: null,
        kind: null,
      }),
    );
    // Dedupe is keyed on the role-free edge (doco, from, to, type).
    expect(mocks.edgeExists).toHaveBeenCalledWith(
      "doco_acme",
      "attributed_to",
      "action_01A",
      "principal_01B",
    );
  });

  it("does not execute any operation when the preflight write gate rejects", async () => {
    mocks.requireDocoTypeWritesForRequest.mockResolvedValue(
      Response.json(
        { error: "Forbidden: write access on 'supports' required to apply this changeset." },
        { status: 403 },
      ),
    );

    const response = await action({
      request: changesetRequest({
        operations: [
          {
            op: "relate",
            relation_kind: "supports",
            from: "decision_01A",
            to: "intent_01B",
          },
        ],
      }),
      params: { docoHandle: "acme" },
    });

    expect(response.status).toBe(403);
    expect(mocks.captureFn).not.toHaveBeenCalled();
    expect(mocks.captureEdge).not.toHaveBeenCalled();
  });
});
