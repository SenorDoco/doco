import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  listMyWorkspaces: vi.fn(),
  listImportDocos: vi.fn(),
  ensureImportDocos: vi.fn(),
  getDocoLevelRole: vi.fn(),
  listAccessibleDocoIdsForPrincipal: vi.fn(),
  listGitHubInstallationChoicesForDocos: vi.fn(),
  getDocoConnectionsContext: vi.fn(),
  buildInstallUrl: vi.fn(),
  connectRepositories: vi.fn(),
  subscribeInstallation: vi.fn(),
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
}));
vi.mock("~/lib/doco-access.server", () => ({
  getDocoLevelRole: mocks.getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal: mocks.listAccessibleDocoIdsForPrincipal,
}));
vi.mock("~/lib/github-connection.server", async (importOriginal) => ({
  pickRepositories: (await importOriginal<typeof import("~/lib/github-connection.server")>())
    .pickRepositories,
  listGitHubInstallationChoicesForDocos: mocks.listGitHubInstallationChoicesForDocos,
  getDocoConnectionsContext: mocks.getDocoConnectionsContext,
  buildInstallUrl: mocks.buildInstallUrl,
  connectRepositories: mocks.connectRepositories,
  subscribeInstallation: mocks.subscribeInstallation,
}));
vi.mock("../api.github.backfill-run", () => ({ kickBackfillRun: mocks.kickBackfillRun }));

import { GITHUB_IMPORTS } from "~/lib/github-imports";
import { action, loader } from "../integrations.github";

const [pullRequests, bugs] = GITHUB_IMPORTS;
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
    workspace_acme: { bugs: { id: "doco_bugs", handle: "acme-bugs" } },
  });
  mocks.ensureImportDocos.mockResolvedValue([
    { import: pullRequests, doco: { id: "doco_prs", handle: "acme-pull-requests" } },
    { import: bugs, doco: { id: "doco_bugs", handle: "acme-bugs" } },
  ]);
  mocks.getDocoLevelRole.mockResolvedValue("owner");
  mocks.listAccessibleDocoIdsForPrincipal.mockResolvedValue(["doco_bugs"]);
  mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([choice]);
  mocks.getDocoConnectionsContext.mockResolvedValue({
    connections: [],
    installations: [],
  });
  mocks.buildInstallUrl.mockReturnValue("https://github.com/apps/doco/installations/new?state=s");
  mocks.connectRepositories.mockResolvedValue(undefined);
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
      workspaces: [
        { handle: "acme", docos: { bugs: { handle: "acme-bugs" } } },
        { handle: "zeta", docos: {} },
      ],
    });
  });

  it("offers the repositories once every chosen Doco exists", async () => {
    mocks.listImportDocos.mockResolvedValue({
      workspace_acme: {
        bugs: { id: "doco_bugs", handle: "acme-bugs" },
        "pull-requests": { id: "doco_prs", handle: "acme-pull-requests" },
      },
    });
    // acme/web already feeds both Docos, so only acme/api is left to add.
    mocks.getDocoConnectionsContext.mockResolvedValue({
      connections: [{ repo: "acme/web", installation_id: 42 }],
      installations: [],
    });
    const data = await loader({ request: get("?workspace=acme&bring=bugs&bring=pull-requests") });
    if (data.step !== "repos") throw new Error(`expected the repos step, got ${data.step}`);
    expect(data.targets.map((t) => [t.import.id, t.doco.handle])).toEqual([
      ["pull-requests", "acme-pull-requests"],
      ["bugs", "acme-bugs"],
    ]);
    expect(data.choices.map((c) => c.selectableRepositories)).toEqual([["acme/api"]]);
    expect(mocks.buildInstallUrl).toHaveBeenCalledWith({
      userId: "user_1",
      docoIds: ["doco_prs", "doco_bugs"],
      next: "/integrations/github?workspace=acme&bring=pull-requests&bring=bugs",
    });
  });
});

describe("/integrations/github action", () => {
  it("brings each choice into its Doco, then asks for repositories", async () => {
    const res = await thrown(
      action({
        request: post({ intent: "choose", workspace: "acme", bring: ["bugs", "pull-requests"] }),
      }),
    );
    expect(mocks.ensureImportDocos).toHaveBeenCalledWith({
      workspace: acme,
      imports: [pullRequests, bugs],
      userId: "user_1",
    });
    expect(res.headers.get("Location")).toBe(
      "/integrations/github?workspace=acme&bring=pull-requests&bring=bugs",
    );
  });

  it("goes straight to GitHub when no installation is available yet", async () => {
    mocks.listGitHubInstallationChoicesForDocos.mockResolvedValue([]);
    const res = await thrown(
      action({
        request: post({ intent: "choose", workspace: "acme", bring: ["pull-requests", "bugs"] }),
      }),
    );
    expect(res.headers.get("Location")).toBe(
      "https://github.com/apps/doco/installations/new?state=s",
    );
    expect(mocks.buildInstallUrl).toHaveBeenCalledWith({
      userId: "user_1",
      docoIds: ["doco_prs", "doco_bugs"],
      next: "/integrations/github?workspace=acme&bring=pull-requests&bring=bugs",
    });
  });

  it("asks again when nothing, or no workspace, was picked", async () => {
    expect(await action({ request: post({ intent: "choose", workspace: "acme" }) })).toEqual({
      error: "Pick at least one thing to bring from GitHub.",
    });
    expect(await action({ request: post({ intent: "choose", bring: "bugs" }) })).toEqual({
      error: "Pick a workspace.",
    });
    expect(mocks.ensureImportDocos).not.toHaveBeenCalled();
  });

  it("creates nothing when the user can't write to a Doco a choice would fill", async () => {
    mocks.getDocoLevelRole.mockResolvedValue("reader");
    expect(
      await action({ request: post({ intent: "choose", workspace: "acme", bring: "bugs" }) }),
    ).toEqual({ error: "Bringing bugs into acme-bugs needs write access to it." });
    expect(mocks.ensureImportDocos).not.toHaveBeenCalled();
  });

  it("connects the picked repositories to every chosen Doco and starts each import", async () => {
    mocks.listImportDocos.mockResolvedValue({
      workspace_acme: {
        bugs: { id: "doco_bugs", handle: "acme-bugs" },
        "pull-requests": { id: "doco_prs", handle: "acme-pull-requests" },
      },
    });
    const res = await thrown(
      action({
        request: post({
          intent: "connect-existing-repos",
          workspace: "acme",
          bring: ["pull-requests", "bugs"],
          installation_id: "42",
          repo: ["acme/web", "acme/api"],
        }),
      }),
    );
    expect(mocks.connectRepositories).toHaveBeenCalledWith("doco_prs", 42, [
      "acme/web",
      "acme/api",
    ]);
    expect(mocks.connectRepositories).toHaveBeenCalledWith("doco_bugs", 42, [
      "acme/web",
      "acme/api",
    ]);
    expect(mocks.kickBackfillRun).toHaveBeenCalledWith("https://doco.test", "doco_prs");
    expect(mocks.kickBackfillRun).toHaveBeenCalledWith("https://doco.test", "doco_bugs");
    expect(res.headers.get("Location")).toBe(
      "/integrations/github?workspace=acme&bring=pull-requests&bring=bugs&github=importing&count=2",
    );
  });

  it("never connects a repository the installation doesn't offer", async () => {
    mocks.listImportDocos.mockResolvedValue({
      workspace_acme: { bugs: { id: "doco_bugs", handle: "acme-bugs" } },
    });
    expect(
      await action({
        request: post({
          intent: "connect-existing-repos",
          workspace: "acme",
          bring: "bugs",
          installation_id: "42",
          repo: "evil/repo",
        }),
      }),
    ).toEqual({ error: "evil/repo is not available from the selected GitHub connection." });
    expect(mocks.connectRepositories).not.toHaveBeenCalled();
  });
});
