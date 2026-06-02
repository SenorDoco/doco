import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  listGitHubInstallationChoicesForDocos: vi.fn(),
  buildInstallUrl: vi.fn(),
  addConnection: vi.fn(),
  removeConnection: vi.fn(),
  reconcileInstallationConnections: vi.fn(),
  setBackfillState: vi.fn(),
  subscribeInstallation: vi.fn(),
  backfillRepoPullRequests: vi.fn(),
  kickBackfillRun: vi.fn(),
  waitUntil: vi.fn(),
}));

vi.mock("@doco/db", () => {
  const rank: Record<string, number> = { reader: 1, writer: 2, owner: 3 };
  return {
    roleAtLeast: (role: string | null, threshold: string) =>
      Boolean(role && rank[role] >= rank[threshold]),
  };
});

vi.mock("@vercel/functions", () => ({
  waitUntil: mocks.waitUntil,
}));

vi.mock("~/lib/db.server", () => ({
  docoPath: (handle: string) => `/tmp/docos/${handle}`,
}));

vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
  getDocoLevelRole: mocks.getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal: mocks.listAccessibleDocoIdsForPrincipal,
}));

vi.mock("~/lib/github-backfill.server", () => ({
  backfillRepoPullRequests: mocks.backfillRepoPullRequests,
}));

vi.mock("~/lib/github-connection.server", () => ({
  addConnection: mocks.addConnection,
  buildInstallUrl: mocks.buildInstallUrl,
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
  githubOrgAccounts: ({
    installations,
    connections,
  }: { installations: unknown[]; connections: Array<{ repo: string }> }) =>
    installations.length > 0
      ? ["acme"]
      : [...new Set(connections.map((connection) => connection.repo.split("/")[0]))],
  listGitHubInstallationChoicesForDocos: mocks.listGitHubInstallationChoicesForDocos,
  parseRepoSlug: (input: string) => {
    const trimmed = input
      .trim()
      .replace(/^https?:\/\/github\.com\//i, "")
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "");
    const match = /^([^/\s]+)\/([^/\s]+)$/.exec(trimmed);
    return match ? { owner: match[1], name: match[2] } : null;
  },
  reconcileInstallationConnections: mocks.reconcileInstallationConnections,
  removeConnection: mocks.removeConnection,
  resumeCursorFromConnections: (connections: Array<{ repo: string; installation_id: number }>) => ({
    status: "running",
    queue: connections.map((connection) => connection.repo),
    repos: connections.length,
    repo_index: 0,
    page: 1,
    installation_id: connections[0]?.installation_id,
  }),
  setBackfillState: mocks.setBackfillState,
  subscribeInstallation: mocks.subscribeInstallation,
}));

vi.mock("../api.github.backfill-run", () => ({
  kickBackfillRun: mocks.kickBackfillRun,
}));

import {
  action,
  buildInstallationPickerChoices,
  connectedOrgRepositories,
  loader,
  resyncButton,
  skippedReposNote,
} from "../$docoHandle.integrations.github";

const routeArgs = {
  params: { docoHandle: "meta-pull-requests" },
};

function postForm(body: Record<string, string | string[]>): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      form.append(key, item);
    }
  }
  return new Request("https://doco.test/meta-pull-requests/integrations/github", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

describe("/:docoHandle/integrations/github", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForRead.mockResolvedValue({
      me: { id: "user_1", username: "alice" },
      meta: {
        docoId: "doco_1",
        ownerId: "workspace_1",
        handle: "meta-pull-requests",
      },
    });
    mocks.getDocoLevelRole.mockResolvedValue("writer");
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "meta-pull-requests",
      workspaceHandle: "meta",
      connections: [],
      installations: [],
      backfill: null,
    });
    mocks.listAccessibleDocoIdsForPrincipal.mockResolvedValue(["doco_existing"]);
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([]);
    mocks.buildInstallUrl.mockReturnValue(
      "https://github.com/apps/doco-pr-sync/installations/new?state=doco_1",
    );
    mocks.addConnection.mockResolvedValue([]);
    mocks.setBackfillState.mockResolvedValue(undefined);
    mocks.subscribeInstallation.mockResolvedValue([]);
    mocks.kickBackfillRun.mockResolvedValue(undefined);
  });

  it("sends writers straight to GitHub when there are no reusable GitHub connections", async () => {
    const response = (await loader({
      request: new Request("https://doco.test/meta-pull-requests/integrations/github"),
      ...routeArgs,
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://github.com/apps/doco-pr-sync/installations/new?state=doco_1",
    );
  });

  it("keeps writers in Doco when reusable GitHub org/repo choices exist", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([
      {
        installation_id: 42,
        account: "acme",
        repositories: ["acme/web", "acme/api"],
        connected_repositories: ["acme/web"],
        source_doco_handles: ["existing-prs"],
      },
    ]);

    const data = await loader({
      request: new Request("https://doco.test/meta-pull-requests/integrations/github"),
      ...routeArgs,
    });

    expect(data.installationChoices).toEqual([
      expect.objectContaining({
        installation_id: 42,
        account: "acme",
        repositories: ["acme/web", "acme/api"],
      }),
    ]);
  });

  it("connects selected repos from a reusable installation and starts the import", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([
      {
        installation_id: 42,
        account: "acme",
        repositories: ["acme/web", "acme/api", "acme/docs"],
        connected_repositories: [],
        source_doco_handles: ["existing-prs"],
      },
    ]);

    const response = (await action({
      request: postForm({
        intent: "connect-existing-repos",
        installation_id: "42",
        repo: ["acme/web", "acme/api"],
      }),
      ...routeArgs,
    }).catch((error: Response) => error)) as Response;

    // Connecting repos now hands the user a standalone "import started" screen
    // (PRG redirect) instead of returning an inline banner message.
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toContain("/meta-pull-requests/integrations/github");
    expect(location).toContain("github=importing");
    expect(location).toContain("count=2");
    expect(mocks.addConnection).toHaveBeenCalledTimes(2);
    expect(mocks.addConnection).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ repo: "acme/web", installation_id: 42 }),
    );
    expect(mocks.addConnection).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ repo: "acme/api", installation_id: 42 }),
    );
    expect(mocks.setBackfillState).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({
        status: "running",
        queue: ["acme/web", "acme/api"],
        repos: 2,
        installation_id: 42,
      }),
    );
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("connects an all-repositories installation when GitHub returns no repo names", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([
      {
        installation_id: 42,
        account: "Doco-to",
        repository_selection: "all",
        repositories: [],
        connected_repositories: [],
        source_doco_handles: ["meta-pull-requests"],
      },
    ]);

    const result = await action({
      request: postForm({
        intent: "connect-installation",
        installation_id: "42",
      }),
      ...routeArgs,
    });

    expect(result).toMatchObject({
      ok: true,
      message: "Connected Doco-to. New pull request activity will sync automatically.",
    });
    expect(mocks.subscribeInstallation).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({
        installation_id: 42,
        account: "Doco-to",
        connected_at: expect.any(String),
      }),
    );
    expect(mocks.addConnection).not.toHaveBeenCalled();
    expect(mocks.setBackfillState).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it("marks an installed GitHub org with no repositories as not selectable", () => {
    const choices = buildInstallationPickerChoices(
      [
        {
          installation_id: 42,
          account: "Doco-to",
          repository_selection: "all",
          repositories: [],
          connected_repositories: [],
          source_doco_handles: ["meta-pull-requests"],
        },
      ],
      new Set(),
    );

    expect(choices).toEqual([
      expect.objectContaining({
        account: "Doco-to",
        selectableRepositories: [],
        connectedRepositories: [],
        hasSelectableRepositories: false,
        canConnectInstallation: true,
      }),
    ]);
  });

  it("does not offer an all-repositories installation that is already connected here", () => {
    const choices = buildInstallationPickerChoices(
      [
        {
          installation_id: 42,
          account: "Doco-to",
          repository_selection: "all",
          repositories: [],
          connected_repositories: [],
          source_doco_handles: ["meta-pull-requests"],
        },
      ],
      new Set(),
      new Set([42]),
    );

    expect(choices).toEqual([
      expect.objectContaining({
        account: "Doco-to",
        isInstallationConnected: true,
        canConnectInstallation: false,
      }),
    ]);
  });

  it("offers only not-yet-connected repos to add, in the order GitHub returned", () => {
    const [choice] = buildInstallationPickerChoices(
      [
        {
          installation_id: 42,
          account: "acme",
          repositories: ["acme/api", "acme/docs", "acme/web"],
          connected_repositories: ["acme/web"],
          source_doco_handles: ["existing-prs"],
        },
      ],
      new Set(["acme/web"]),
    );

    expect(choice.selectableRepositories).toEqual(["acme/api", "acme/docs"]);
    expect(choice.connectedRepositories).toEqual(["acme/web"]);
    expect(choice.hasSelectableRepositories).toBe(true);
  });

  it("lists the repositories covered by a connected org installation", () => {
    expect(
      connectedOrgRepositories(
        [
          {
            installation_id: 42,
            account: "Doco-to",
            repository_selection: "all",
            repositories: ["Doco-to/web", "Doco-to/api"],
            connected_repositories: [],
            source_doco_handles: ["meta-pull-requests"],
          },
          {
            installation_id: 99,
            account: "other",
            repositories: ["other/x"],
            connected_repositories: [],
            source_doco_handles: ["other-prs"],
          },
        ],
        new Set([42]),
      ),
    ).toEqual(["Doco-to/api", "Doco-to/web"]);
  });

  it("returns no covered repositories when nothing is connected at the org level", () => {
    expect(
      connectedOrgRepositories(
        [
          {
            installation_id: 42,
            account: "Doco-to",
            repositories: ["Doco-to/web"],
            connected_repositories: [],
            source_doco_handles: ["meta-pull-requests"],
          },
        ],
        new Set(),
      ),
    ).toEqual([]);
  });

  it("surfaces the connected org's repositories through the loader", async () => {
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "meta-pull-requests",
      workspaceHandle: "meta",
      connections: [],
      installations: [{ installation_id: 42, account: "Doco-to" }],
      backfill: null,
    });
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([
      {
        installation_id: 42,
        account: "Doco-to",
        repository_selection: "all",
        repositories: ["Doco-to/api", "Doco-to/web"],
        connected_repositories: [],
        source_doco_handles: ["meta-pull-requests"],
      },
    ]);

    const data = await loader({
      request: new Request("https://doco.test/meta-pull-requests/integrations/github"),
      ...routeArgs,
    });

    const connectedInstallationIds = new Set(
      data.installations.map((installation) => installation.installation_id),
    );
    expect(connectedOrgRepositories(data.installationChoices, connectedInstallationIds)).toEqual([
      "Doco-to/api",
      "Doco-to/web",
    ]);
    expect(data.docoInstallUrl).toBe(
      "https://github.com/apps/doco-pr-sync/installations/new?state=doco_1",
    );
  });

  it("turns a failed per-repo Re-import into a friendly message, not a 500", async () => {
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "meta-pull-requests",
      workspaceHandle: "meta",
      connections: [{ repo: "acme/web", installation_id: 42 }],
      installations: [],
      backfill: null,
    });
    mocks.backfillRepoPullRequests.mockRejectedValue(new Error("GitHub GET … failed: 403"));

    const result = await action({
      request: postForm({ intent: "backfill", repo: "acme/web" }),
      ...routeArgs,
    });

    expect(result).toMatchObject({ error: expect.stringContaining("acme/web") });
  });
});

// The recovery control must NEVER be disabled: a stuck "running" marker is the
// exact situation it exists to fix, so disabling it while running locked users
// out (the original bug). It stays clickable; only its label changes.
describe("resyncButton", () => {
  it("is enabled while importing, framed as a restart", () => {
    expect(resyncButton({ status: "running" })).toEqual({
      label: "Restart import",
      disabled: false,
    });
  });
  it("is enabled when idle or finished", () => {
    expect(resyncButton(null)).toEqual({ label: "Re-import all PRs", disabled: false });
    expect(resyncButton({ status: "done" })).toEqual({
      label: "Re-import all PRs",
      disabled: false,
    });
  });
});

describe("skippedReposNote", () => {
  it("is null when nothing was skipped", () => {
    expect(skippedReposNote(null)).toBeNull();
    expect(skippedReposNote({ status: "running" })).toBeNull();
    expect(skippedReposNote({ status: "running", errors: [] })).toBeNull();
  });
  it("names the skipped repositories so the gap is visible", () => {
    const note = skippedReposNote({
      status: "done",
      errors: [
        { repo: "acme/a", message: "404", at: "t" },
        { repo: "acme/b", message: "403", at: "t" },
      ],
    });
    expect(note).toContain("acme/a");
    expect(note).toContain("acme/b");
    expect(note).toMatch(/couldn.t be imported/i);
  });
});
