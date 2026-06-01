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
}));

vi.mock("../api.github.backfill-run", () => ({
  kickBackfillRun: mocks.kickBackfillRun,
}));

import { action, buildInstallationPickerChoices, loader } from "../$docoHandle.integrations.github";

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
        ownerId: "organization_1",
        handle: "meta-pull-requests",
      },
    });
    mocks.getDocoLevelRole.mockResolvedValue("writer");
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "meta-pull-requests",
      orgHandle: "meta",
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

    const result = await action({
      request: postForm({
        intent: "connect-existing-repos",
        installation_id: "42",
        repo: ["acme/web", "acme/api"],
      }),
      ...routeArgs,
    });

    expect(result).toMatchObject({ ok: true });
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

  it("marks an installed GitHub org with no repositories as not selectable", () => {
    const choices = buildInstallationPickerChoices(
      [
        {
          installation_id: 42,
          account: "Doco-to",
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
      }),
    ]);
  });
});
