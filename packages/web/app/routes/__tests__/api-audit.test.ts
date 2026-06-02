import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canReadDocoForRequest: vi.fn(),
  docoPath: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
  normalizeDocoParams: vi.fn(),
  readAuditEvents: vi.fn(),
  readDocoMetadata: vi.fn(),
}));

vi.mock("~/lib/audit-log.server", () => ({
  readAuditEvents: mocks.readAuditEvents,
}));

vi.mock("~/lib/db.server", () => ({
  docoPath: mocks.docoPath,
}));

vi.mock("~/lib/doco-access.server", () => ({
  canReadDocoForRequest: mocks.canReadDocoForRequest,
  normalizeDocoParams: mocks.normalizeDocoParams,
}));

vi.mock("~/lib/doco-metadata.server", () => ({
  readDocoMetadata: mocks.readDocoMetadata,
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));

import { loader } from "../$docoHandle.api.audit[.]json";

describe("/<doco>/api/audit.json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeDocoParams.mockResolvedValue({
      ownerSlug: "torre",
      docoSlug: "bpms",
      handle: "torre/bpms",
    });
    mocks.docoPath.mockReturnValue("/tmp/doco/bpms");
    mocks.readDocoMetadata.mockResolvedValue({
      docoId: "doco_bpms",
      handle: "bpms",
      ownerId: "workspace_torre",
      workspaceId: "workspace_torre",
      visibility: "private",
      goal: "",
    });
    mocks.getCurrentPrincipalAsync.mockResolvedValue({
      id: "user_alice",
      username: "alice",
    });
    mocks.canReadDocoForRequest.mockResolvedValue(true);
    mocks.readAuditEvents.mockResolvedValue([]);
  });

  it("forwards before and doco id to the audit reader", async () => {
    const request = new Request(
      "https://doco.test/torre/bpms/api/audit.json?before=2026-05-27T13%3A33%3A27.000Z&limit=50",
    );

    const response = await loader({
      request,
      params: { docoHandle: "torre/bpms" },
    } as never);

    expect(response.status).toBe(200);
    expect(mocks.readAuditEvents).toHaveBeenCalledWith(
      "/tmp/doco/bpms",
      expect.objectContaining({
        before: "2026-05-27T13:33:27.000Z",
        limit: 50,
      }),
      "doco_bpms",
    );
  });
});
