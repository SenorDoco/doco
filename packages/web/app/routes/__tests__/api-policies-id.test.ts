import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  getDocoLevelRoleForRequest: vi.fn(),
  loadPolicyForEdit: vi.fn(),
  capturePolicy: vi.fn(),
  transitionPolicyLifecycle: vi.fn(),
  resolvePrincipalIdForUser: vi.fn(),
  authoringContextForRequest: vi.fn(),
}));

vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
  getDocoLevelRoleForRequest: mocks.getDocoLevelRoleForRequest,
}));

vi.mock("~/lib/capture.server", () => ({
  loadPolicyForEdit: mocks.loadPolicyForEdit,
  capturePolicy: mocks.capturePolicy,
  transitionPolicyLifecycle: mocks.transitionPolicyLifecycle,
}));

vi.mock("~/lib/principal-user.server", () => ({
  resolvePrincipalIdForUser: mocks.resolvePrincipalIdForUser,
}));

vi.mock("~/lib/authoring-source.server", () => ({
  authoringContextForRequest: mocks.authoringContextForRequest,
}));

import { action, loader } from "../$docoHandle.api.policies.$id[.]json";

const PARAMS = { docoHandle: "bpms", id: "policy_old" };

function jsonRequest(body: unknown, method = "PATCH"): Request {
  return new Request("https://doco.test/bpms/api/policies/policy_old.json", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/<doco>/api/policies/<id>.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForRead.mockResolvedValue({
      dir: "/tmp/doco",
      docoSlug: "bpms",
      ownerSlug: "torre",
      me: { id: "user_alice", username: "alice" },
      meta: { ownerId: "workspace_torre", docoId: "doco_bpms" },
    });
    mocks.getDocoLevelRoleForRequest.mockResolvedValue("owner");
    mocks.resolvePrincipalIdForUser.mockResolvedValue("principal_alice");
    mocks.authoringContextForRequest.mockResolvedValue({});
  });

  it("GET returns the stored policy via loadPolicyForEdit", async () => {
    mocks.loadPolicyForEdit.mockResolvedValue({
      ok: true,
      lifecycle: "active",
      data: { kind: "suggestion", predicate: { agent_instruction: "Be concrete." } },
    });

    const response = await loader({
      request: new Request("https://doco.test/bpms/api/policies/policy_old.json"),
      params: PARAMS,
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "policy_old",
      kind: "suggestion",
      lifecycle: "active",
    });
  });

  it("GET 404s an unknown policy", async () => {
    mocks.loadPolicyForEdit.mockResolvedValue({
      error: "Policy policy_old not found.",
      status: 404,
    });
    const response = await loader({
      request: new Request("https://doco.test/bpms/api/policies/policy_old.json"),
      params: PARAMS,
    } as never);
    expect(response.status).toBe(404);
  });

  it("requires owner role to modify", async () => {
    mocks.getDocoLevelRoleForRequest.mockResolvedValue("writer");
    const response = await action({
      request: jsonRequest({ lifecycle: "retired" }),
      params: PARAMS,
    } as never);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("owner role required"),
    });
    expect(mocks.transitionPolicyLifecycle).not.toHaveBeenCalled();
    expect(mocks.capturePolicy).not.toHaveBeenCalled();
  });

  it("retires a policy with a bare lifecycle transition (no supersession)", async () => {
    mocks.transitionPolicyLifecycle.mockResolvedValue({ ok: true });
    const response = await action({
      request: jsonRequest({ lifecycle: "retired" }),
      params: PARAMS,
    } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      id: "policy_old",
      lifecycle: "retired",
    });
    expect(mocks.transitionPolicyLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ policyId: "policy_old", newLifecycle: "retired" }),
    );
    expect(mocks.capturePolicy).not.toHaveBeenCalled();
  });

  it("re-activates a retired policy with lifecycle=active", async () => {
    mocks.transitionPolicyLifecycle.mockResolvedValue({ ok: true });
    const response = await action({
      request: jsonRequest({ lifecycle: "active" }),
      params: PARAMS,
    } as never);
    expect(response.status).toBe(200);
    expect(mocks.transitionPolicyLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ policyId: "policy_old", newLifecycle: "active" }),
    );
  });

  it("modifies a policy by supersession: captures a new one and retires the old", async () => {
    mocks.loadPolicyForEdit.mockResolvedValue({
      ok: true,
      lifecycle: "active",
      data: { kind: "suggestion" },
    });
    mocks.capturePolicy.mockResolvedValue({
      ok: true,
      id: "policy_new",
      footer_lines: ["[🔮 Doco] policy added"],
    });
    mocks.transitionPolicyLifecycle.mockResolvedValue({ ok: true });

    const response = await action({
      request: jsonRequest({ kind: "suggestion", agent_instruction: "Prefer examples." }),
      params: PARAMS,
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      id: "policy_new",
      superseded: "policy_old",
    });
    expect(mocks.capturePolicy).toHaveBeenCalledWith(
      "/tmp/doco",
      "doco_bpms",
      "torre",
      "bpms",
      expect.objectContaining({ kind: "suggestion", authored_by_principal_id: "principal_alice" }),
      "https://doco.test",
      expect.any(Object),
    );
    expect(mocks.transitionPolicyLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        policyId: "policy_old",
        newLifecycle: "retired",
        supersededBy: "policy_new",
      }),
    );
  });

  it("rejects a body that is neither a draft nor a valid lifecycle transition", async () => {
    const response = await action({
      request: jsonRequest({ on_violation: "warn" }),
      params: PARAMS,
    } as never);
    expect(response.status).toBe(400);
    expect(mocks.transitionPolicyLifecycle).not.toHaveBeenCalled();
    expect(mocks.capturePolicy).not.toHaveBeenCalled();
  });
});
