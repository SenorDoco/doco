import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  getWorkspaceRole: vi.fn(),
  buildSlackInstallUrl: vi.fn(),
  getSlackConfig: vi.fn(),
  loadSlackMirrorStatus: vi.fn(),
  setSlackMirrorChannelExcluded: vi.fn(),
  stopSlackMirror: vi.fn(),
}));

vi.mock("@doco/db", () => ({ getWorkspaceRole: mocks.getWorkspaceRole }));
vi.mock("~/lib/doco-access.server", () => ({ loadDocoRouteForRead: mocks.loadDocoRouteForRead }));
vi.mock("~/lib/slack.server", () => ({
  buildSlackInstallUrl: mocks.buildSlackInstallUrl,
  getSlackConfig: mocks.getSlackConfig,
}));
vi.mock("~/lib/slack-mirror-setup.server", () => ({
  MIRROR_HISTORY_YEARS: 6,
  loadSlackMirrorStatus: mocks.loadSlackMirrorStatus,
  setSlackMirrorChannelExcluded: mocks.setSlackMirrorChannelExcluded,
  stopSlackMirror: mocks.stopSlackMirror,
}));

import { action, loader } from "../$docoHandle.integrations.slack";

const params = { docoHandle: "acme-slack" };
const meta = {
  docoId: "doco_slack",
  handle: "acme-slack",
  ownerId: "workspace_1",
  workspaceId: "workspace_1",
  visibility: "private",
};

function post(fields: Record<string, string>): Request {
  return new Request("https://doco.test/acme-slack/integrations/slack", {
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
  mocks.getSlackConfig.mockReturnValue({ configured: true });
  mocks.buildSlackInstallUrl.mockReturnValue("https://slack.com/oauth/v2/authorize?state=s");
  mocks.loadSlackMirrorStatus.mockResolvedValue(null);
});

describe("/:docoHandle/integrations/slack loader", () => {
  it("lets a workspace owner manage the mirror", async () => {
    const data = await loader({ request: new Request("https://doco.test/x"), params });
    expect(data).toMatchObject({ handle: "acme-slack", canManage: true, status: null });
  });

  it("shows but doesn't let a non-owner manage", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("writer");
    const data = await loader({ request: new Request("https://doco.test/x"), params });
    expect(data).toMatchObject({ canManage: false });
  });
});

describe("/:docoHandle/integrations/slack action", () => {
  it("sends a consenting owner to Slack to approve the mirror", async () => {
    const result = await run({ intent: "start", consent: "on" });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "https://slack.com/oauth/v2/authorize?state=s",
    );
    expect(mocks.buildSlackInstallUrl).toHaveBeenCalledWith(
      expect.any(Request),
      "user_owner",
      "workspace_1",
      { mirrorDocoId: "doco_slack" },
    );
  });

  it("requires the explicit consent checkbox", async () => {
    expect(await run({ intent: "start" })).toMatchObject({
      error: expect.stringContaining("copy"),
    });
    expect(mocks.buildSlackInstallUrl).not.toHaveBeenCalled();
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
    expect(mocks.buildSlackInstallUrl).not.toHaveBeenCalled();
  });

  it("only lets an owner of the Doco's workspace manage the mirror", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("writer");
    expect(await run({ intent: "stop" })).toMatchObject({
      error: expect.stringContaining("owner"),
    });
    expect(mocks.stopSlackMirror).not.toHaveBeenCalled();
  });

  it("excludes and re-includes a channel", async () => {
    await run({ intent: "exclude", channel_id: "C2" });
    await run({ intent: "include", channel_id: "C2" });

    expect(mocks.setSlackMirrorChannelExcluded.mock.calls).toEqual([
      [{ docoId: "doco_slack", channelId: "C2", excluded: true }],
      [{ docoId: "doco_slack", channelId: "C2", excluded: false }],
    ]);
  });

  it("stops the mirror, deleting the copy", async () => {
    expect(await run({ intent: "stop" })).toMatchObject({ ok: true });
    expect(mocks.stopSlackMirror).toHaveBeenCalledWith("doco_slack");
  });
});
