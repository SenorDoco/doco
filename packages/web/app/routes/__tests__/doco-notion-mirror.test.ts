import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  getWorkspaceRole: vi.fn(),
  getNotionConfig: vi.fn(),
  buildNotionAuthorizeUrl: vi.fn(),
  loadNotionMirrorStatus: vi.fn(),
  requestNotionResync: vi.fn(),
  stopNotionMirror: vi.fn(),
}));

vi.mock("@doco/db", () => ({ getWorkspaceRole: mocks.getWorkspaceRole }));
vi.mock("~/lib/doco-access.server", () => ({ loadDocoRouteForRead: mocks.loadDocoRouteForRead }));
vi.mock("~/lib/notion-api.server", () => ({ getNotionConfig: mocks.getNotionConfig }));
vi.mock("~/lib/notion-mirror-setup.server", () => ({
  buildNotionAuthorizeUrl: mocks.buildNotionAuthorizeUrl,
  loadNotionMirrorStatus: mocks.loadNotionMirrorStatus,
  requestNotionResync: mocks.requestNotionResync,
  stopNotionMirror: mocks.stopNotionMirror,
}));

import { action, loader } from "../$docoHandle.integrations.notion";

const params = { docoHandle: "acme-notion" };
const meta = {
  docoId: "doco_notion",
  handle: "acme-notion",
  ownerId: "workspace_1",
  workspaceId: "workspace_1",
  visibility: "private",
};

function post(fields: Record<string, string>): Request {
  return new Request("https://doco.test/acme-notion/integrations/notion", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

async function run(fields: Record<string, string>) {
  return action({ request: post(fields), params }).catch((e: unknown) => e);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadDocoRouteForRead.mockResolvedValue({
    me: { id: "user_owner" },
    meta,
    ownerSlug: "acme",
  });
  mocks.getWorkspaceRole.mockResolvedValue("owner");
  mocks.getNotionConfig.mockReturnValue({ configured: true });
  mocks.buildNotionAuthorizeUrl.mockReturnValue(
    "https://api.notion.com/v1/oauth/authorize?state=s",
  );
  mocks.loadNotionMirrorStatus.mockResolvedValue(null);
});

describe("/:docoHandle/integrations/notion loader", () => {
  it("lets a workspace owner manage the mirror", async () => {
    const data = await loader({ request: new Request("https://doco.test/x"), params });
    expect(data).toMatchObject({
      handle: "acme-notion",
      canManage: true,
      notionConfigured: true,
      status: null,
    });
  });

  it("shows but doesn't let a non-owner manage", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("writer");
    const data = await loader({ request: new Request("https://doco.test/x"), params });
    expect(data).toMatchObject({ canManage: false });
  });
});

describe("/:docoHandle/integrations/notion action", () => {
  it("sends a consenting owner to Notion's authorization page", async () => {
    const result = await run({ intent: "start", consent: "on" });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "https://api.notion.com/v1/oauth/authorize?state=s",
    );
    expect(mocks.buildNotionAuthorizeUrl).toHaveBeenCalledWith(expect.any(Request), {
      docoId: "doco_notion",
      workspaceId: "workspace_1",
      userId: "user_owner",
    });
  });

  it("requires the explicit consent checkbox", async () => {
    expect(await run({ intent: "start" })).toMatchObject({
      error: expect.stringContaining("copy"),
    });
    expect(mocks.buildNotionAuthorizeUrl).not.toHaveBeenCalled();
  });

  it("refuses to mirror into a public Doco", async () => {
    mocks.loadDocoRouteForRead.mockResolvedValue({
      me: { id: "user_owner" },
      meta: { ...meta, visibility: "public" },
      ownerSlug: "acme",
    });
    expect(await run({ intent: "start", consent: "on" })).toMatchObject({
      error: expect.stringContaining("private"),
    });
    expect(mocks.buildNotionAuthorizeUrl).not.toHaveBeenCalled();
  });

  it("explains when Notion isn't configured on this host", async () => {
    mocks.buildNotionAuthorizeUrl.mockReturnValue(null);
    expect(await run({ intent: "start", consent: "on" })).toMatchObject({
      error: expect.stringContaining("configured"),
    });
  });

  it("reconnects without asking for consent again", async () => {
    const result = await run({ intent: "reconnect" });
    expect((result as Response).headers.get("Location")).toContain("oauth/authorize");
  });

  it("only lets an owner of the Doco's workspace manage the mirror", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("writer");
    expect(await run({ intent: "stop" })).toMatchObject({
      error: expect.stringContaining("owner"),
    });
    expect(mocks.stopNotionMirror).not.toHaveBeenCalled();
  });

  it("requests a re-sync", async () => {
    expect(await run({ intent: "resync" })).toMatchObject({ ok: true });
    expect(mocks.requestNotionResync).toHaveBeenCalledWith("doco_notion");
  });

  it("stops the mirror, deleting the copy", async () => {
    expect(await run({ intent: "stop" })).toMatchObject({ ok: true });
    expect(mocks.stopNotionMirror).toHaveBeenCalledWith("doco_notion");
  });
});
