import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  listAccessRequestsForOwner: vi.fn(),
  requestDocoAccess: vi.fn(),
  approveAccessRequest: vi.fn(),
  denyAccessRequest: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: mocks.getCurrentPrincipal }));
vi.mock("~/lib/access-requests.server", () => ({
  listAccessRequestsForOwner: mocks.listAccessRequestsForOwner,
  requestDocoAccess: mocks.requestDocoAccess,
  approveAccessRequest: mocks.approveAccessRequest,
  denyAccessRequest: mocks.denyAccessRequest,
}));

import { action, loader } from "../access-requests";

function postForm(fields: Record<string, string>): Request {
  return new Request("https://doco.to/access-requests", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("/access-requests route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_owner", username: "owner" });
    mocks.listAccessRequestsForOwner.mockResolvedValue([]);
  });

  it("loader redirects to sign-in when signed out", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);
    await expect(
      loader({ request: new Request("https://doco.to/access-requests") }),
    ).rejects.toMatchObject({ status: 302 });
  });

  it("loader returns the owner inbox + sent flag when signed in", async () => {
    mocks.listAccessRequestsForOwner.mockResolvedValue([{ id: "accreq_1" }]);
    const data = await loader({
      request: new Request("https://doco.to/access-requests?sent=acme"),
    });
    expect(data.inbox).toEqual([{ id: "accreq_1" }]);
    expect(data.sent).toBe("acme");
    expect(mocks.listAccessRequestsForOwner).toHaveBeenCalledWith("user_owner");
  });

  it("action intent=request creates a request and redirects to ?sent", async () => {
    const res = await action({
      request: postForm({ intent: "request", doco: "acme", role: "writer" }),
    });
    expect(mocks.requestDocoAccess).toHaveBeenCalledWith({
      docoHandleOrId: "acme",
      requesterId: "user_owner",
      requestedRole: "writer",
      reason: null,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/access-requests?sent=acme");
  });

  it("action intent=request defaults an unknown role to reader", async () => {
    await action({ request: postForm({ intent: "request", doco: "acme", role: "superuser" }) });
    expect(mocks.requestDocoAccess).toHaveBeenCalledWith(
      expect.objectContaining({ requestedRole: "reader" }),
    );
  });

  it("action intent=approve approves as the signed-in owner", async () => {
    await action({ request: postForm({ intent: "approve", id: "accreq_1" }) });
    expect(mocks.approveAccessRequest).toHaveBeenCalledWith({
      id: "accreq_1",
      approverId: "user_owner",
    });
  });

  it("action intent=deny denies as the signed-in owner", async () => {
    await action({ request: postForm({ intent: "deny", id: "accreq_1" }) });
    expect(mocks.denyAccessRequest).toHaveBeenCalledWith({
      id: "accreq_1",
      approverId: "user_owner",
    });
  });

  it("action redirects to sign-in when signed out", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);
    await expect(
      action({ request: postForm({ intent: "approve", id: "x" }) }),
    ).rejects.toMatchObject({ status: 302 });
  });
});
