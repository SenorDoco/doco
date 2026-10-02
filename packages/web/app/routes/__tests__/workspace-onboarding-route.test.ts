import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  getWorkspaceRole: vi.fn(),
  resolveWorkspaceByHandle: vi.fn(),
  ensureWorkspaceDoco: vi.fn(),
  finishSourcesStep: vi.fn(),
  loadOnboardingProgress: vi.fn(),
  slackConfigured: vi.fn(),
  slackAuthorizeUrl: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  getWorkspaceRole: mocks.getWorkspaceRole,
  withClient: (fn: (c: unknown) => unknown) => fn({}),
}));
vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: mocks.getCurrentPrincipal }));
vi.mock("~/lib/workspace-helpers.server", () => ({
  ensureWorkspaceDoco: mocks.ensureWorkspaceDoco,
  resolveWorkspaceByHandle: mocks.resolveWorkspaceByHandle,
}));
vi.mock("~/lib/knowledge-sources.server", () => ({
  KNOWLEDGE_SOURCE_CONNECTORS: {
    slack: { configured: mocks.slackConfigured, authorizeUrl: mocks.slackAuthorizeUrl },
    notion: { configured: () => false, authorizeUrl: () => null },
  },
}));
vi.mock("~/lib/onboarding.server", () => ({
  finishSourcesStep: mocks.finishSourcesStep,
  loadOnboardingProgress: mocks.loadOnboardingProgress,
}));

import { action, loader } from "../workspaces.$workspaceHandle.onboarding";

const ACME = { id: "workspace_acme", handle: "acme" };

function post(fields: Record<string, string>) {
  return action({
    request: new Request("https://doco.test/workspaces/acme/onboarding", {
      method: "POST",
      body: new URLSearchParams(fields),
    }),
    params: { workspaceHandle: "acme" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_alice", username: "alice" });
  mocks.resolveWorkspaceByHandle.mockResolvedValue(ACME);
  mocks.getWorkspaceRole.mockResolvedValue("owner");
});

describe("POST /workspaces/:handle/onboarding", () => {
  // Connecting GitHub belongs to the GitHub setup (/integrations/github),
  // which asks which repositories to bring; this route never connects any.
  it("has no GitHub connect of its own", async () => {
    const res = await post({ intent: "github", installation: "42" });
    expect(res.headers.get("Location")).toBe("/workspaces/acme?onboarding=unknown");
  });

  it("creates a private Doco for a source and goes to approve its copy, coming back here", async () => {
    mocks.slackConfigured.mockReturnValue(true);
    mocks.ensureWorkspaceDoco.mockResolvedValue({
      id: "doco_slack",
      handle: "acme-slack",
      visibility: "private",
    });
    mocks.slackAuthorizeUrl.mockReturnValue("https://slack.com/oauth/v2/authorize?state=s");
    const res = await post({ intent: "source", integration: "slack" });
    expect(res.headers.get("Location")).toBe("https://slack.com/oauth/v2/authorize?state=s");
    expect(mocks.ensureWorkspaceDoco).toHaveBeenCalledWith({
      workspace: ACME,
      template: "slack",
      handleSuffix: "slack",
      userId: "user_alice",
    });
    expect(mocks.slackAuthorizeUrl.mock.calls[0][1]).toEqual({
      docoId: "doco_slack",
      workspaceId: "workspace_acme",
      userId: "user_alice",
      next: "/workspaces/acme",
    });
  });

  it("never copies a source into a public Doco", async () => {
    mocks.slackConfigured.mockReturnValue(true);
    mocks.ensureWorkspaceDoco.mockResolvedValue({
      id: "doco_slack",
      handle: "acme-slack",
      visibility: "public",
    });
    const res = await post({ intent: "source", integration: "slack" });
    expect(res.headers.get("Location")).toBe("/workspaces/acme?onboarding=source_public");
    expect(mocks.slackAuthorizeUrl).not.toHaveBeenCalled();
  });

  it("refuses a source the host hasn't set up, or one that isn't a source", async () => {
    for (const integration of ["notion", "github", "nope"]) {
      const res = await post({ intent: "source", integration });
      expect(res.headers.get("Location")).toBe("/workspaces/acme?onboarding=source_unavailable");
    }
    expect(mocks.ensureWorkspaceDoco).not.toHaveBeenCalled();
  });

  it("finishes (or skips) the other sources", async () => {
    const res = await post({ intent: "finish-sources" });
    expect(res.headers.get("Location")).toBe("/workspaces/acme");
    expect(mocks.finishSourcesStep).toHaveBeenCalledWith(
      {},
      { workspaceId: "workspace_acme", userId: "user_alice" },
    );
  });

  it("leaves a workspace's sources to its owners", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("writer");
    const res = await post({ intent: "finish-sources" });
    expect(res.headers.get("Location")).toBe("/workspaces/acme?onboarding=not_owner");
    expect(mocks.finishSourcesStep).not.toHaveBeenCalled();
  });

  it("sends someone signed out to sign in", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);
    const res = await post({ intent: "finish-sources" }).catch((r: Response) => r);
    expect(res.headers.get("Location")).toBe("/sign-in?next=%2Fworkspaces%2Facme");
  });
});

describe("GET /workspaces/:handle/onboarding", () => {
  it("says where the person stands, for the agent step to poll", async () => {
    mocks.loadOnboardingProgress.mockResolvedValue({
      steps: [
        { step: "github", done: true },
        { step: "sources", done: true },
        { step: "agent", done: true },
      ],
    });
    const res = await loader({
      request: new Request("https://doco.test/workspaces/acme/onboarding"),
      params: { workspaceHandle: "acme" },
    });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).pending).toBeNull();
  });
});
