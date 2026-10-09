import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  listMyWorkspaces: vi.fn(),
  listImportDocos: vi.fn(),
  ensureImportDocos: vi.fn(),
  prepareImport: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
  listGitHubInstallationChoicesForDocos: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  buildInstallUrl: vi.fn(),
  connectPicked: vi.fn(),
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
vi.mock("@vercel/functions", () => ({ waitUntil: mocks.waitUntil }));
vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: mocks.getCurrentPrincipal }));
vi.mock("~/lib/workspace-helpers.server", () => ({ listMyWorkspaces: mocks.listMyWorkspaces }));
vi.mock("~/lib/github-setup.server", () => ({
  listImportDocos: mocks.listImportDocos,
  ensureImportDocos: mocks.ensureImportDocos,
  prepareImport: mocks.prepareImport,
}));
vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal: mocks.listAccessibleDocoIdsForPrincipal,
}));
vi.mock("~/lib/github-connection.server", async (importOriginal) => ({
  pickConnections: (await importOriginal<typeof import("~/lib/github-connection.server")>())
    .pickConnections,
  listGitHubInstallationChoicesForDocos: mocks.listGitHubInstallationChoicesForDocos,
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
  buildInstallUrl: mocks.buildInstallUrl,
  connectPicked: mocks.connectPicked,
}));
vi.mock("../api.github.backfill-run", () => ({ kickBackfillRun: mocks.kickBackfillRun }));

import { GITHUB_IMPORTS } from "~/lib/github-imports";
import { action, loader } from "../integrations.github";

const [pullRequests, issues, codebase] = GITHUB_IMPORTS;
const acme = { id: "workspace_acme", handle: "acme" };
const choice = {
  installation_id: 42,
  account: "acme",
  repositories: ["acme/web", "acme/api"],
  connected_repositories: [],
  source_doco_handles: [],
};

const get = (query = "") => new Request(`https://doco.test/integrations/github${query}`);
function post(body: Record<string, string | string[]>): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) form.append(key, item);
  }
  return new Request("https://doco.test/integrations/github", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
}
const thrown = (p: Promise<unknown>) => p.catch((e: unknown) => e) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_1", username: "ana" });
  mocks.listMyWorkspaces.mockResolvedValue([acme, { id: "workspace_zeta", handle: "zeta" }]);
  mocks.listImportDocos.mockResolvedValue({
    workspace_acme: { "github-issues": { id: "doco_issues", handle: "acme-github-issues" } },
  });
  mocks.ensureImportDocos.mockResolvedValue([
    { import: pullRequests, doco: { id: "doco_prs", handle: "acme-pull-requests" } },
  ]);
  mocks.prepareImport.mockImplementation(async ({ imports, picked }) =>
    imports.map((i: (typeof GITHUB_IMPORTS)[number]) => ({
      import: i,
      doco: { id: `doco_${i.id}`, handle: `acme-${i.id}` },
      picked,
    })),
  );
  mocks.getDocoLevelRole.mockResolvedValue("owner");
  mocks.listAccessibleDocoIdsForPrincipal.mockResolvedValue(["doco_issues"]);
  mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([choice]);
  mocks.getDocoConnectionsContext.mockResolvedValue({
    connections: [],
    installations: [],
  });
  mocks.buildInstallUrl.mockReturnValue("https://github.com/apps/doco/installations/new?state=s");
  mocks.connectPicked.mockResolvedValue(true);
  mocks.kickBackfillRun.mockResolvedValue(undefined);
});

describe("/integrations/github loader", () => {
  it("sends a signed-out visitor to sign in first", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);
    const res = await thrown(loader({ request: get("?workspace=acme") }));
    expect(res.headers.get("Location")).toBe(
      "/sign-in?next=%2Fintegrations%2Fgithub%3Fworkspace%3Dacme",
    );
  });

  it("asks which workspace and what to bring, naming the Doco each choice fills", async () => {
    const data = await loader({ request: get("?workspace=acme") });
    expect(data).toMatchObject({
      step: "choose",
      workspaceHandle: "acme",
      // Everything GitHub can bring starts picked: one setup fills every Doco.
      bring: ["pull-requests", "github-issues", "codebase"],
      workspaces: [
        { handle: "acme", docos: { "github-issues": { handle: "acme-github-issues" } } },
        { handle: "zeta", docos: {} },
      ],
    });
  });

  it("offers the repositories once every chosen Doco exists", async () => {
    mocks.listImportDocos.mockResolvedValue({
      workspace_acme: {
        "github-issues": { id: "doco_issues", handle: "acme-github-issues" },
        "pull-requests": { id: "doco_prs", handle: "acme-pull-requests" },
      },
    });
    // acme/web already feeds the pull requests Doco, so only acme/api is left
    // to add; the issues Doco, holding only the repositories that use GitHub
    // issues, doesn't count.
    mocks.getDocoConnectionsContext.mockImplementation(async (id: string) => ({
      connections: id === "doco_prs" ? [{ repo: "acme/web", installation_id: 42 }] : [],
      installations: [],
    }));
    const data = await loader({
      request: get("?workspace=acme&bring=github-issues&bring=pull-requests"),
    });
    if (data.step !== "repos") throw new Error(`expected the repos step, got ${data.step}`);
    expect(data.targets.map((t) => [t.import.id, t.doco.handle])).toEqual([
      ["pull-requests", "acme-pull-requests"],
      ["github-issues", "acme-github-issues"],
    ]);
    expect(mocks.getDocoConnectionsContext).toHaveBeenCalledTimes(1);
    expect(data.choices.map((c) => c.selectableRepositories)).toEqual([["acme/api"]]);
    expect(mocks.buildInstallUrl).toHaveBeenCalledWith({
      userId: "user_1",
      docoIds: ["doco_prs", "doco_issues"],
      next: "/integrations/github?workspace=acme&bring=pull-requests&bring=github-issues",
    });
  });

  it("offers the repositories before the issues Doco exists, since it waits for them", async () => {
    mocks.listImportDocos.mockResolvedValue({
      workspace_acme: { "pull-requests": { id: "doco_prs", handle: "acme-pull-requests" } },
    });
    const data = await loader({
      request: get("?workspace=acme&bring=pull-requests&bring=github-issues"),
    });
    expect(data.step).toBe("repos");
    const missingPrs = await loader({
      request: get("?workspace=zeta&bring=pull-requests&bring=github-issues"),
    });
    expect(missingPrs.step).toBe("choose");
  });
});

describe("/integrations/github action", () => {
  it("brings each choice into its Doco, then asks for repositories", async () => {
    const res = await thrown(
      action({
        request: post({
          intent: "choose",
          workspace: "acme",
          bring: ["github-issues", "pull-requests"],
        }),
      }),
    );
    // The issues Doco waits for the repositories.
    expect(mocks.ensureImportDocos).toHaveBeenCalledWith({
      workspace: acme,
      imports: [pullRequests],
      userId: "user_1",
    });
    expect(res.headers.get("Location")).toBe(
      "/integrations/github?workspace=acme&bring=pull-requests&bring=github-issues",
    );
  });

  it("brings all three at once, creating each Doco the workspace lacks but the issues one", async () => {
    const res = await thrown(
      action({
        request: post({
          intent: "choose",
          workspace: "acme",
          bring: ["pull-requests", "github-issues", "codebase"],
        }),
      }),
    );
    expect(mocks.ensureImportDocos).toHaveBeenCalledWith({
      workspace: acme,
      imports: [pullRequests, codebase],
      userId: "user_1",
    });
    expect(res.headers.get("Location")).toBe(
      "/integrations/github?workspace=acme&bring=pull-requests&bring=github-issues&bring=codebase",
    );
  });

  it("goes straight to GitHub when no installation is available yet", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([]);
    const res = await thrown(
      action({
        request: post({
          intent: "choose",
          workspace: "acme",
          bring: ["pull-requests", "github-issues"],
        }),
      }),
    );
    expect(res.headers.get("Location")).toBe(
      "https://github.com/apps/doco/installations/new?state=s",
    );
    expect(mocks.buildInstallUrl).toHaveBeenCalledWith({
      userId: "user_1",
      docoIds: ["doco_prs"],
      next: "/integrations/github?workspace=acme&bring=pull-requests&bring=github-issues",
    });
  });

  it("creates the issues Doco up front only to carry a GitHub install when it is all that's chosen", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([]);
    await thrown(
      action({ request: post({ intent: "choose", workspace: "acme", bring: "github-issues" }) }),
    );
    expect(mocks.ensureImportDocos).toHaveBeenCalledWith({
      workspace: acme,
      imports: [issues],
      userId: "user_1",
    });

    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([choice]);
    mocks.ensureImportDocos.mockClear();
    await thrown(
      action({ request: post({ intent: "choose", workspace: "acme", bring: "github-issues" }) }),
    );
    expect(mocks.ensureImportDocos).toHaveBeenCalledWith({
      workspace: acme,
      imports: [],
      userId: "user_1",
    });
  });

  it("asks again when nothing, or no workspace, was picked", async () => {
    expect(await action({ request: post({ intent: "choose", workspace: "acme" }) })).toEqual({
      error: "Pick at least one thing to bring from GitHub.",
    });
    expect(await action({ request: post({ intent: "choose", bring: "github-issues" }) })).toEqual({
      error: "Pick a workspace.",
    });
    expect(mocks.ensureImportDocos).not.toHaveBeenCalled();
  });

  it("creates nothing when the user can't write to a Doco a choice would fill", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("reader");
    expect(
      await action({
        request: post({ intent: "choose", workspace: "acme", bring: "github-issues" }),
      }),
    ).toEqual({ error: "Bringing issues into acme-github-issues needs write access to it." });
    expect(mocks.ensureImportDocos).not.toHaveBeenCalled();
  });

  it("connects the picked repositories to every Doco they fill and starts each import", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([
      choice,
      { ...choice, installation_id: 7, account: "zeta", repositories: ["zeta/docs"] },
    ]);
    // Only zeta/docs uses GitHub issues.
    mocks.prepareImport.mockImplementation(async ({ picked }) => [
      { import: pullRequests, doco: { id: "doco_prs", handle: "acme-pull-requests" }, picked },
      {
        import: issues,
        doco: { id: "doco_issues", handle: "acme-github-issues" },
        picked: { ...picked, connections: [{ repo: "zeta/docs", installation_id: 7 }] },
      },
    ]);
    const res = await thrown(
      action({
        request: post({
          intent: "connect",
          workspace: "acme",
          bring: ["pull-requests", "github-issues"],
          repo: ["acme/web", "zeta/docs"],
        }),
      }),
    );
    // One pick spans organizations: each repository keeps its own installation.
    const picked = [
      { repo: "acme/web", installation_id: 42 },
      { repo: "zeta/docs", installation_id: 7 },
    ];
    expect(mocks.prepareImport).toHaveBeenCalledWith({
      workspace: acme,
      imports: [pullRequests, issues],
      picked: { connections: picked, installations: [] },
      userId: "user_1",
    });
    expect(mocks.connectPicked).toHaveBeenCalledWith("doco_prs", {
      connections: picked,
      installations: [],
    });
    expect(mocks.connectPicked).toHaveBeenCalledWith("doco_issues", {
      connections: [{ repo: "zeta/docs", installation_id: 7 }],
      installations: [],
    });
    expect(mocks.kickBackfillRun).toHaveBeenCalledWith("https://doco.test", "doco_prs");
    expect(mocks.kickBackfillRun).toHaveBeenCalledWith("https://doco.test", "doco_issues");
    expect(res.headers.get("Location")).toBe(
      "/integrations/github?workspace=acme&bring=pull-requests&bring=github-issues&github=importing&count=2&into=pull-requests&into=github-issues&issue_repos=1",
    );
  });

  it("leaves issues out when none of the repositories use GitHub issues", async () => {
    mocks.prepareImport.mockImplementation(async ({ picked }) => [
      { import: pullRequests, doco: { id: "doco_prs", handle: "acme-pull-requests" }, picked },
    ]);
    const res = await thrown(
      action({
        request: post({
          intent: "connect",
          workspace: "acme",
          bring: ["pull-requests", "github-issues"],
          repo: "acme/web",
        }),
      }),
    );
    expect(mocks.connectPicked).toHaveBeenCalledTimes(1);
    expect(res.headers.get("Location")).toBe(
      "/integrations/github?workspace=acme&bring=pull-requests&bring=github-issues&github=importing&count=1&into=pull-requests&issue_repos=0",
    );
  });

  it("names each organization picked whole, whose later repositories follow", async () => {
    const res = await thrown(
      action({
        request: post({
          intent: "connect",
          workspace: "acme",
          bring: "codebase",
          installation: "42",
        }),
      }),
    );
    expect(res.headers.get("Location")).toBe(
      "/integrations/github?workspace=acme&bring=codebase&github=importing&count=2&org=acme&into=codebase",
    );
  });

  it("never connects a repository the installation doesn't offer", async () => {
    expect(
      await action({
        request: post({
          intent: "connect",
          workspace: "acme",
          bring: "github-issues",
          repo: "evil/repo",
        }),
      }),
    ).toEqual({ error: "evil/repo is not available from your GitHub connections." });
    expect(mocks.prepareImport).not.toHaveBeenCalled();
    expect(mocks.connectPicked).not.toHaveBeenCalled();
  });
});
