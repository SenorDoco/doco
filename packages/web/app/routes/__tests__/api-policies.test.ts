import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureGuidancePolicy: vi.fn(),
  captureNodeAuthoringPolicy: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listPrincipals: vi.fn(),
  loadDocoRouteForRead: vi.fn(),
  withClient: vi.fn(),
  withIdempotency: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  listPrincipals: mocks.listPrincipals,
  withClient: mocks.withClient,
}));

vi.mock("~/lib/capture.server", () => ({
  captureGuidancePolicy: mocks.captureGuidancePolicy,
  captureNodeAuthoringPolicy: mocks.captureNodeAuthoringPolicy,
}));

vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
}));

vi.mock("~/lib/idempotency.server", () => ({
  withIdempotency: (
    request: Request,
    key: string,
    principalId: string | null,
    bodyText: string,
    fn: () => unknown,
  ) => mocks.withIdempotency(request, key, principalId, bodyText, fn),
}));

import { action } from "../$docoHandle.api.policies[.]json";

function jsonRequest(body: unknown): Request {
  return new Request("https://doco.test/bpms/api/policies.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/<doco>/api/policies.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForRead.mockResolvedValue({
      dir: "/tmp/doco",
      docoSlug: "bpms",
      ownerSlug: "torre",
      me: { id: "user_alice", username: "alice" },
      meta: { ownerId: "workspace_torre", docoId: "doco_bpms" },
    });
    mocks.listPrincipals.mockResolvedValue([
      {
        id: "principal_alice",
        name: "alice",
        data: { created_by: "user_alice" },
      },
    ]);
    mocks.withIdempotency.mockImplementation(
      (
        _request: Request,
        _key: string,
        _principalId: string | null,
        _bodyText: string,
        fn: () => unknown,
      ) => fn(),
    );
  });

  it("requires owner scope before attempting to write a policy", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("writer");

    const response = await action({
      request: jsonRequest({
        policy_kind: "guidance",
        policy: "Use qualified doco labels.",
        created_by: "principal_spoofed",
        created_by_principal_id: "principal_spoofed",
        created_by_user_id: "user_spoofed",
      }),
      params: { docoHandle: "bpms" },
    } as never);

    expect(mocks.loadDocoRouteForRead).toHaveBeenCalledWith(
      expect.any(Request),
      { docoHandle: "bpms" },
      "owner",
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "Forbidden: owner role required to write policies.",
    });
    expect(mocks.captureGuidancePolicy).not.toHaveBeenCalled();
  });

  it("lets doco owners create guidance policies", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("owner");
    mocks.captureGuidancePolicy.mockResolvedValue({
      ok: true,
      id: "guidance_policy_123",
      footer_lines: ["[🔮 Doco] policy added"],
    });

    const response = await action({
      request: jsonRequest({
        policy_kind: "guidance",
        policy: "Use qualified doco labels.",
      }),
      params: { docoHandle: "bpms" },
    } as never);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ id: "guidance_policy_123" });
    expect(mocks.captureGuidancePolicy).toHaveBeenCalledWith(
      "/tmp/doco",
      "doco_bpms",
      "torre",
      "bpms",
      expect.objectContaining({
        authored_by_principal_id: "principal_alice",
        created_by_user_id: "user_alice",
      }),
      "https://doco.test",
      expect.any(Object),
    );
  });
});
