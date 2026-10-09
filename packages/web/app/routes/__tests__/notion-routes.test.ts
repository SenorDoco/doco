// The Notion OAuth callback: nothing in its query string is trusted on its
// own. The state must be one the consent form signed for the signed-in user,
// the Doco must still live in the workspace that user owns, and the code is
// exchanged before the mirror is recorded.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoById: vi.fn(),
  getWorkspaceRole: vi.fn(),
  getNotionConfig: vi.fn(),
  exchangeNotionCode: vi.fn(),
  enableNotionMirror: vi.fn(),
  verifyNotionState: vi.fn(),
  getCurrentPrincipalAsync: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getDocoById: mocks.getDocoById,
  getWorkspaceRole: mocks.getWorkspaceRole,
}));
vi.mock("~/lib/notion-api.server", () => ({
  getNotionConfig: mocks.getNotionConfig,
  exchangeNotionCode: mocks.exchangeNotionCode,
}));
vi.mock("~/lib/notion-mirror-setup.server", () => ({
  enableNotionMirror: mocks.enableNotionMirror,
  notionRedirectUri: () => "https://doco.test/integrations/notion/callback",
  verifyNotionState: mocks.verifyNotionState,
}));
vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipalAsync: mocks.getCurrentPrincipalAsync,
}));

import { loader } from "../integrations.notion.callback";

const state = {
  docoId: "doco_notion",
  workspaceId: "workspace_1",
  userId: "user_owner",
};
const tokens = { access_token: "a", workspace_id: "ws-1", bot_id: "b" };

async function callback(query: string): Promise<string | null> {
  const result = await loader({
    request: new Request(`https://doco.test/integrations/notion/callback?${query}`),
  }).catch((e: unknown) => e);
  expect(result).toBeInstanceOf(Response);
  return (result as Response).headers.get("Location");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getNotionConfig.mockReturnValue({ clientSecret: "secret", configured: true });
  mocks.verifyNotionState.mockReturnValue(state);
  mocks.getDocoById.mockResolvedValue({
    id: "doco_notion",
    handle: "acme-notion",
    workspace_id: "workspace_1",
  });
  mocks.getCurrentPrincipalAsync.mockResolvedValue({ id: "user_owner" });
  mocks.getWorkspaceRole.mockResolvedValue("owner");
  mocks.exchangeNotionCode.mockResolvedValue(tokens);
  mocks.enableNotionMirror.mockResolvedValue({ ok: true });
});

describe("/integrations/notion/callback", () => {
  it("turns the mirror on and returns to the mirror page", async () => {
    expect(await callback("code=c1&state=signed")).toBe(
      "/acme-notion/integrations/notion?notion=mirroring",
    );
    expect(mocks.verifyNotionState).toHaveBeenCalledWith("signed");
    expect(mocks.exchangeNotionCode).toHaveBeenCalledWith(
      "c1",
      "https://doco.test/integrations/notion/callback",
    );
    expect(mocks.enableNotionMirror).toHaveBeenCalledWith({
      docoId: "doco_notion",
      tokens,
      consentedBy: "user_owner",
    });
  });

  it("returns to the workspace's onboarding when the connect started there", async () => {
    mocks.verifyNotionState.mockReturnValue({ ...state, next: "/workspaces/acme" });
    expect(await callback("code=c1&state=signed")).toBe("/workspaces/acme");
  });

  it("rejects a state it did not sign", async () => {
    mocks.verifyNotionState.mockReturnValue(null);
    expect(await callback("code=c1&state=forged")).toBe("/workspaces?notion=invalid_state");
    expect(mocks.exchangeNotionCode).not.toHaveBeenCalled();
  });

  it("rejects a Doco that moved or vanished since consent", async () => {
    mocks.getDocoById.mockResolvedValue({ id: "doco_notion", workspace_id: "workspace_2" });
    expect(await callback("code=c1&state=signed")).toBe("/workspaces?notion=doco_not_found");
  });

  it("reports a cancelled authorization", async () => {
    expect(await callback("error=access_denied&state=signed")).toBe(
      "/acme-notion/integrations/notion?notion=denied",
    );
    expect(mocks.exchangeNotionCode).not.toHaveBeenCalled();
  });

  it("requires the signed-in user who consented, still an owner", async () => {
    mocks.getCurrentPrincipalAsync.mockResolvedValueOnce(null);
    expect(await callback("code=c1&state=signed")).toBe(
      "/acme-notion/integrations/notion?notion=signin_required",
    );
    mocks.getCurrentPrincipalAsync.mockResolvedValueOnce({ id: "user_other" });
    expect(await callback("code=c1&state=signed")).toBe(
      "/acme-notion/integrations/notion?notion=forbidden",
    );
    mocks.getWorkspaceRole.mockResolvedValueOnce("writer");
    expect(await callback("code=c1&state=signed")).toBe(
      "/acme-notion/integrations/notion?notion=not_owner",
    );
    expect(mocks.enableNotionMirror).not.toHaveBeenCalled();
  });

  it("explains a failed code exchange", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.exchangeNotionCode.mockRejectedValueOnce(new Error("invalid_grant"));
    expect(await callback("code=c1&state=signed")).toBe(
      "/acme-notion/integrations/notion?notion=authorization_failed",
    );
    error.mockRestore();
  });

  it("explains when the Notion workspace is already mirrored elsewhere", async () => {
    mocks.enableNotionMirror.mockResolvedValue({
      ok: false,
      reason: "workspace_mirrored_elsewhere",
      handle: "acme-other",
    });
    expect(await callback("code=c1&state=signed")).toBe(
      "/acme-notion/integrations/notion?notion=workspace_mirrored_elsewhere&handle=acme-other",
    );
  });
});
