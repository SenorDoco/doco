// Alexander, 2026-10-08: one-click Allow (decision_01M4EQPJ6AKETJ1508W254DXVB).
// The device page asks for no token name, and someone who owns nothing can
// still allow an agent, which acts as them.
import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  getDeviceAuthorizationByUserCode: vi.fn(),
  approveDeviceAuthorization: vi.fn(),
  readOAuthApprovalGrants: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: mocks.getCurrentPrincipal }));
vi.mock("~/lib/oauth-server.server", () => ({
  approveDeviceAuthorization: mocks.approveDeviceAuthorization,
  denyDeviceAuthorization: vi.fn(),
  getClient: vi.fn(),
  getDeviceAuthorizationByUserCode: mocks.getDeviceAuthorizationByUserCode,
}));
vi.mock("~/lib/oauth-approval-grants.server", () => ({
  loadApprovalGrantOptions: vi.fn(),
  readOAuthApprovalGrants: mocks.readOAuthApprovalGrants,
}));

import DevicePage, { action } from "../device";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice" });
  mocks.getDeviceAuthorizationByUserCode.mockResolvedValue({
    device_code: "doco_dc_1",
    client_id: "doco_client_codex",
    status: "pending",
    expires_at: new Date(Date.now() + 60_000),
  });
  mocks.readOAuthApprovalGrants.mockResolvedValue({
    granted_doco_ids: [],
    granted_doco_roles: {},
    granted_doco_write_types: {},
    granted_workspace_ids: [],
    granted_workspace_roles: {},
    granted_workspace_write_types: {},
    grant_type: "actor",
    actor_role: null,
  });
});

describe("/device", () => {
  it("approves with no token name", async () => {
    await action({
      request: new Request("https://doco.test/device", {
        method: "POST",
        body: new URLSearchParams({ user_code: "WXYZ-1234", decision: "approve", grants: "[]" }),
      }),
    });

    expect(mocks.approveDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(mocks.approveDeviceAuthorization.mock.calls[0]?.[0]).not.toHaveProperty("token_name");
  });

  it("offers Allow to someone who owns no docos or workspaces", () => {
    const router = createMemoryRouter(
      [{ id: "device", path: "/device", element: <DevicePage /> }],
      {
        initialEntries: ["/device?user_code=WXYZ-1234"],
        hydrationData: {
          loaderData: {
            device: {
              user_code: "WXYZ-1234",
              stage: "approve",
              client_name: "Codex",
              docos: [],
              workspaces: [],
              requested_role: null,
              me: { id: "user_alice" },
            },
          },
        },
      },
    );
    const html = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(html).toContain("Allow Codex to use Doco");
    expect(html).toContain(">Allow<");
    expect(html).toContain(">Deny<");
    expect(html).not.toContain("You don&#x27;t own any docos or workspaces");
    expect(html).not.toContain("token");
  });
});
