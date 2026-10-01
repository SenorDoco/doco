// The agent step needs an Agents chats Doco for the agent to write in. Every
// new workspace starts with one; an older workspace gets it once someone
// reaches that step there.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadOnboardingProgress: vi.fn(),
  ensureWorkspaceDoco: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [] }) }),
}));
vi.mock("../onboarding.server", () => ({ loadOnboardingProgress: mocks.loadOnboardingProgress }));
vi.mock("../workspace-helpers.server", () => ({ ensureWorkspaceDoco: mocks.ensureWorkspaceDoco }));
vi.mock("../doco-access.server", () => ({ listAccessibleDocoIdsForPrincipal: async () => [] }));
vi.mock("../github-app.server", () => ({ githubAppConfigured: () => true }));
vi.mock("../github-connection.server", () => ({ listKnownGitHubAccounts: async () => [] }));
vi.mock("../github-setup.server", () => ({ listImportDocos: async () => ({}) }));
vi.mock("../knowledge-sources.server", () => ({
  KNOWLEDGE_SOURCE_CONNECTORS: {},
  sourceConnected: async () => false,
}));

import { loadOnboardingView } from "../onboarding-view.server";

const ACME = { id: "workspace_acme", handle: "acme" };
const request = new Request("https://doco.to/workspaces/acme");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureWorkspaceDoco.mockResolvedValue({
    id: "doco_chats",
    handle: "acme-agents-chats",
    visibility: "private",
  });
});

describe("loadOnboardingView", () => {
  it("gives the workspace an Agents chats Doco once the person reaches the agent step", async () => {
    mocks.loadOnboardingProgress.mockResolvedValue({
      workspaceId: ACME.id,
      workspaceHandle: ACME.handle,
      userId: "user_bo",
      joinedAs: "invitee",
      steps: [{ step: "agent", done: false }],
    });
    const view = await loadOnboardingView({ request, workspace: ACME, userId: "user_bo" });
    expect(mocks.ensureWorkspaceDoco).toHaveBeenCalledWith({
      workspace: ACME,
      template: "agents-chats",
      handleSuffix: "agents-chats",
      userId: "user_bo",
    });
    expect(view?.agent.agentsChatsHandle).toBe("acme-agents-chats");
  });

  it("makes nothing while an earlier step is open", async () => {
    mocks.loadOnboardingProgress.mockResolvedValue({
      workspaceId: ACME.id,
      workspaceHandle: ACME.handle,
      userId: "user_ana",
      joinedAs: "creator",
      steps: [
        { step: "github", done: false },
        { step: "sources", done: false },
        { step: "agent", done: false },
      ],
    });
    const view = await loadOnboardingView({ request, workspace: ACME, userId: "user_ana" });
    expect(view?.pending).toBe("github");
    expect(mocks.ensureWorkspaceDoco).not.toHaveBeenCalled();
  });
});
