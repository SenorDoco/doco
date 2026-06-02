import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  requireDocoTypeWritesForRequest: vi.fn(),
  captureFn: vi.fn(),
  captureEdge: vi.fn(),
  edgeExists: vi.fn(),
  getEntity: vi.fn(),
  withClient: vi.fn(),
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
}));

vi.mock("~/lib/node-capture-registry.server", () => ({
  CAPTURE_REGISTRY_BY_ENTITY_TYPE: {
    decision: {
      entityType: "decision",
      captureFn: mocks.captureFn,
    },
  },
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

  it("preserves the edge role on broad role-bearing relations", async () => {
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

    // The role must survive onto the edge — a role-less attributed_to edge
    // fails the `performed_by` authoring policy and gets duplicated by a
    // second, role-bearing edge from the direct edges route.
    expect(mocks.captureEdge).toHaveBeenCalledWith(
      expect.objectContaining({
        edgeType: "attributed_to",
        fromId: "action_01A",
        toId: "principal_01B",
        props: { role: "performed_by" },
      }),
    );
    // Dedupe must key on the role, not a role-less edge.
    expect(mocks.edgeExists).toHaveBeenCalledWith(
      "doco_acme",
      "attributed_to",
      "action_01A",
      "principal_01B",
      "performed_by",
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
