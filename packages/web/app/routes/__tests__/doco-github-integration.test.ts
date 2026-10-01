import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDocoRouteForRead: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  listGitHubInstallationChoicesForDocos: vi.fn(),
  buildInstallUrl: vi.fn(),
  connectRepositories: vi.fn(),
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
  repoBackfillFor: () => mocks.backfillRepoPullRequests,
}));

vi.mock("~/lib/github-connection.server", async (importOriginal) => ({
  pickConnections: (await importOriginal<typeof import("~/lib/github-connection.server")>())
    .pickConnections,
  connectRepositories: mocks.connectRepositories,
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
  addableInstallationChoices,
  buildInstallationPickerChoices,
} from "~/components/github-repo-picker";
import {
  action,
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
    mocks.connectRepositories.mockResolvedValue(undefined);
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

  it("says what the Doco brings from GitHub, by its template", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([
      { installation_id: 42, account: "acme", repositories: [], connected_repositories: [] },
    ]);
    mocks.getDocoConnectionsContext.mockResolvedValue({
      handle: "meta-github-bugs",
      workspaceHandle: "meta",
      template: "github-bugs",
      connections: [],
      installations: [],
      backfill: null,
    });

    const data = await loader({
      request: new Request("https://doco.test/meta-github-bugs/integrations/github"),
      ...routeArgs,
    });

    expect(data.brings).toMatchObject({ id: "github-bugs", items: "bugs" });
    expect(mocks.buildInstallUrl).toHaveBeenCalledWith({
      userId: "user_1",
      docoIds: ["doco_1"],
      next: "/meta-pull-requests/integrations/github",
    });
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

  it("connects the picked repos, across organizations, and returns to the importing Doco", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([
      {
        installation_id: 42,
        account: "acme",
        repositories: ["acme/web", "acme/api", "acme/docs"],
        connected_repositories: [],
        source_doco_handles: ["existing-prs"],
      },
      {
        installation_id: 7,
        account: "zeta",
        repositories: ["zeta/app"],
        connected_repositories: [],
        source_doco_handles: [],
      },
    ]);

    const response = (await action({
      request: postForm({ intent: "connect", repo: ["acme/web", "zeta/app"] }),
      ...routeArgs,
    }).catch((error: Response) => error)) as Response;

    // The Doco itself shows the import filling it: no separate screen to click through.
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/meta-pull-requests");
    expect(mocks.connectRepositories).toHaveBeenCalledWith("doco_1", [
      { repo: "acme/web", installation_id: 42 },
      { repo: "zeta/app", installation_id: 7 },
    ]);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("connects a whole organization: every repository it lists, imported now, and later ones", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([
      {
        installation_id: 42,
        account: "torre-labs",
        repository_selection: "selected",
        repositories: ["torre-labs/heda", "torre-labs/vader"],
        connected_repositories: [],
        source_doco_handles: ["meta-pull-requests"],
      },
    ]);

    const response = (await action({
      request: postForm({ intent: "connect", installation: "42" }),
      ...routeArgs,
    }).catch((error: Response) => error)) as Response;

    expect(response.headers.get("Location")).toBe("/meta-pull-requests");
    // Subscribed, so repositories GitHub gives Doco later come in too…
    expect(mocks.subscribeInstallation).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({
        installation_id: 42,
        account: "torre-labs",
        connected_at: expect.any(String),
      }),
    );
    // …and every repository it lists now starts importing.
    expect(mocks.connectRepositories).toHaveBeenCalledWith("doco_1", [
      { repo: "torre-labs/heda", installation_id: 42 },
      { repo: "torre-labs/vader", installation_id: 42 },
    ]);
    expect(mocks.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("subscribes an organization GitHub lists no repositories for, with nothing to import yet", async () => {
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

    const response = (await action({
      request: postForm({ intent: "connect", installation: "42" }),
      ...routeArgs,
    }).catch((error: Response) => error)) as Response;

    expect(response.headers.get("Location")).toBe("/meta-pull-requests");
    expect(mocks.subscribeInstallation).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ installation_id: 42, account: "Doco-to" }),
    );
    expect(mocks.connectRepositories).not.toHaveBeenCalled();
    expect(mocks.waitUntil).not.toHaveBeenCalled();
  });

  it("offers every organization as a whole, even one whose repositories are all connected", () => {
    const choices = buildInstallationPickerChoices(
      [
        {
          installation_id: 42,
          account: "torre-labs",
          repository_selection: "selected",
          repositories: ["torre-labs/heda"],
          connected_repositories: ["torre-labs/heda"],
          source_doco_handles: ["meta-pull-requests"],
        },
      ],
      new Set(["torre-labs/heda"]),
    );

    expect(addableInstallationChoices(choices)).toEqual([
      expect.objectContaining({
        account: "torre-labs",
        selectableRepositories: [],
        connectedRepositories: ["torre-labs/heda"],
        isInstallationConnected: false,
      }),
    ]);
  });

  it("does not offer an organization that is already connected here as a whole", () => {
    const choices = buildInstallationPickerChoices(
      [
        {
          installation_id: 42,
          account: "Doco-to",
          repository_selection: "all",
          repositories: ["Doco-to/app"],
          connected_repositories: [],
          source_doco_handles: ["meta-pull-requests"],
        },
      ],
      new Set(),
      new Set([42]),
    );

    expect(choices).toEqual([
      expect.objectContaining({ account: "Doco-to", isInstallationConnected: true }),
    ]);
    expect(addableInstallationChoices(choices)).toEqual([]);
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

  it("has no free-form connect: a posted installation id is never trusted", async () => {
    const result = await action({
      request: postForm({ intent: "connect", repo: "acme/web", installation_id: "42" }),
      ...routeArgs,
    });

    expect(result).toMatchObject({
      error: "acme/web is not available from your GitHub connections.",
    });
    expect(mocks.connectRepositories).not.toHaveBeenCalled();
  });

  it("re-imports without adding repositories the Doco never picked", async () => {
    const ctx = {
      handle: "meta-pull-requests",
      workspaceHandle: "meta",
      connections: [{ repo: "acme/web", installation_id: 42 }],
      installations: [],
      backfill: null,
    };
    mocks.getDocoConnectionsContext.mockResolvedValue(ctx);

    await action({ request: postForm({ intent: "resync-all" }), ...routeArgs });

    expect(mocks.reconcileInstallationConnections).toHaveBeenCalledWith("doco_1", []);
    expect(mocks.setBackfillState).toHaveBeenCalledWith(
      "doco_1",
      expect.objectContaining({ queue: ["acme/web"] }),
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
    expect(resyncButton({ status: "running" }, { items: "bugs" })).toEqual({
      label: "Restart import",
      disabled: false,
    });
  });
  it("is enabled when idle or finished", () => {
    expect(resyncButton(null, { items: "pull requests" })).toEqual({
      label: "Re-import all pull requests",
      disabled: false,
    });
    expect(resyncButton({ status: "done" }, { items: "bugs" })).toEqual({
      label: "Re-import all bugs",
      disabled: false,
    });
  });
});

describe("skippedReposNote", () => {
  const files = { items: "files", permission: "Contents" };
  it("is null when nothing was skipped", () => {
    expect(skippedReposNote(null, files)).toBeNull();
    expect(skippedReposNote({ status: "running" }, files)).toBeNull();
    expect(skippedReposNote({ status: "running", errors: [] }, files)).toBeNull();
  });
  it("names the skipped repositories so the gap is visible", () => {
    const note = skippedReposNote(
      {
        status: "done",
        errors: [
          { repo: "acme/a", message: "404", at: "t", status: 404 },
          { repo: "acme/b", message: "500", at: "t", status: 500 },
        ],
      },
      files,
    );
    expect(note).toContain("acme/a");
    expect(note).toContain("acme/b");
    expect(note).toMatch(/couldn.t be imported/i);
  });
  it("counts every skipped repository and says what GitHub needs when it refused access", () => {
    const note = skippedReposNote(
      {
        status: "done",
        skipped: 14,
        errors: [{ repo: "torrenegra/worder", message: "403", at: "t", status: 403 }],
      },
      files,
    );
    expect(note).toContain("14 repositories couldn't be imported");
    expect(note).toContain(
      "GitHub doesn't let Doco's GitHub App read their files: give the App Contents read access in GitHub.",
    );
  });
});
